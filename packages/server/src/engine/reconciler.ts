import os from 'node:os';
import path from 'node:path';
import type {
  AgentRuntime, AttentionAlert, EventEntry, ModelUsageEntry, OrrerySnapshot, SubagentNode, TaskItem, TaskStatus,
  TimelineSegment, TodoItem, TokenActivityPayload, TokenRatePoint,
} from '@orrery/shared';
import type { CollectorOutput } from '../adapters/types.js';

const HOUR = 3_600_000;
const TOKEN_BUCKET_MS = 15_000;
type DailyCounter = { total: number; provider: string; model?: string; adapterId?: string };
const modelKey = (provider: string, model?: string) => JSON.stringify([provider, model]);

export interface ReconcilerHistory {
  tasksById?: Map<string, TaskItem>;
  agents?: Map<string, { collectedAt: string; cpu: number[]; memory: number[] }>;
  tokens?: {
    observedAt: number;
    bucketStart: number;
    pending: number;
    counters: Map<string, number>;
    points: TokenRatePoint[];
    midnight: number;
    daily: Map<string, DailyCounter>;
  };
}

function uniqueBy<T>(values: T[], key: (value: T) => string | number) {
  const seen = new Set<string | number>();
  return values.filter(value => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function latestEvents(events: EventEntry[]) {
  return uniqueBy(events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)), event => event.id).slice(0, 200);
}

function uniqueSubagents(nodes: SubagentNode[], childIds: Map<string, string>) {
  const seen = new Set<string>();
  return nodes.filter(node => {
    const child = node.childThreadId && (childIds.get(node.childThreadId) ?? node.childThreadId);
    const duplicate = seen.has(node.id) || (child && seen.has(child));
    seen.add(node.id);
    if (child) seen.add(child);
    return !duplicate;
  });
}

function normalizedCwd(cwd: string) {
  if (/^[a-z]:|\\|^\/\//i.test(cwd)) {
    const windows = cwd.replaceAll('/', '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    return path.win32.normalize(windows).replace(/\\$/, '').toLowerCase();
  }
  return path.posix.normalize(cwd).replace(/\/$/, '') || '/';
}

function isWaiting(status: TaskStatus) {
  return status === 'waiting_approval' || status === 'waiting_input';
}

function isActive(status: TaskStatus) {
  return status === 'running' || isWaiting(status);
}

function agentId(task: TaskItem) {
  switch (task.source) {
    case 'codex-app':
    case 'codex-cli': return 'codex';
    case 't3-codex': return task.externalIds.t3ThreadId ? 't3' : 'codex';
    default: return task.source;
  }
}

function mergeTasks(t3: TaskItem, codex: TaskItem, childIds: Map<string, string>): TaskItem {
  return {
    ...t3,
    externalIds: {
      ...codex.externalIds,
      ...t3.externalIds,
      codexThreadId: codex.externalIds.codexThreadId ?? t3.externalIds.codexThreadId,
      rolloutPath: codex.externalIds.rolloutPath ?? t3.externalIds.rolloutPath,
    },
    source: 't3-codex',
    sourceLabel: 'T3 → Codex',
    title: t3.title || codex.title,
    project: t3.project ?? codex.project,
    cwd: t3.cwd ?? codex.cwd,
    gitBranch: t3.gitBranch ?? codex.gitBranch,
    worktreePath: t3.worktreePath ?? codex.worktreePath,
    linkedPrUrl: t3.linkedPrUrl ?? codex.linkedPrUrl,
    updatedAt: Date.parse(t3.updatedAt) >= Date.parse(codex.updatedAt) ? t3.updatedAt : codex.updatedAt,
    model: codex.model ?? t3.model,
    reasoningEffort: codex.reasoningEffort ?? t3.reasoningEffort,
    currentStep: codex.currentStep ?? t3.currentStep,
    tokens: codex.tokens ? {
      ...codex.tokens,
      contextWindow: codex.tokens.contextWindow ?? t3.tokens?.contextWindow,
      contextPercent: codex.tokens.contextPercent ?? t3.tokens?.contextPercent,
    } : t3.tokens,
    recentSteps: uniqueBy([...codex.recentSteps, ...t3.recentSteps], step => step.id)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    subagents: uniqueSubagents([...t3.subagents, ...codex.subagents.map(node =>
      node.parentId === codex.id ? { ...node, parentId: t3.id } : node)], childIds),
    hasActionablePlan: t3.hasActionablePlan || codex.hasActionablePlan,
  };
}

function joinSources(outputs: CollectorOutput[]) {
  const input = uniqueBy(outputs.flatMap(output => output.tasks)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)), task => task.id);
  const t3 = input.filter(task => task.source === 't3' ||
    (task.source === 't3-codex' && task.externalIds.t3ThreadId));
  const codex = input.filter(task => agentId(task) === 'codex');
  const matches = new Map<string, TaskItem>();
  const aliases = new Map<string, string>();
  const withNativeId = t3.filter(task => task.externalIds.codexThreadId);
  const nativeIds = new Map(uniqueBy(withNativeId, task => task.externalIds.codexThreadId!)
    .map(task => [task.externalIds.codexThreadId, task]));
  for (const native of codex) {
    const owner = native.externalIds.codexThreadId && nativeIds.get(native.externalIds.codexThreadId);
    if (!owner || matches.has(owner.id)) continue;
    matches.set(owner.id, native);
    aliases.set(native.id, owner.id);
  }

  // Reserve all exact matches before assigning any time-based matches.
  const candidates = t3.filter(task => task.provider === 'codex' && task.cwd && !matches.has(task.id))
    .map(task => ({ task, cwd: normalizedCwd(task.cwd!), started: Date.parse(task.startedAt) }));
  const nearby = codex.filter(task => task.source === 't3-codex' && task.cwd && !aliases.has(task.id))
    .flatMap(native => {
      const cwd = normalizedCwd(native.cwd!);
      const started = Date.parse(native.startedAt);
      return candidates.filter(candidate => candidate.cwd === cwd)
        .map(candidate => ({ owner: candidate.task, native, distance: Math.abs(candidate.started - started) }))
        .filter(pair => pair.distance <= 120_000);
    }).sort((a, b) => a.distance - b.distance);
  for (const { owner, native } of nearby) {
    if (matches.has(owner.id) || aliases.has(native.id)) continue;
    matches.set(owner.id, native);
    aliases.set(native.id, owner.id);
  }
  const childIds = new Map<string, string>();
  for (const owner of t3) {
    const nativeId = matches.get(owner.id)?.externalIds.codexThreadId ?? owner.externalIds.codexThreadId;
    if (nativeId && owner.externalIds.t3ThreadId) childIds.set(nativeId, owner.externalIds.t3ThreadId);
  }
  const tasks = input.filter(task => !aliases.has(task.id)).map(task => {
    const native = matches.get(task.id);
    return native ? mergeTasks(task, native, childIds) : task;
  });
  return { tasks, matches, aliases, childIds };
}

function buildTimeline(
  outputs: CollectorOutput[], taskById: Map<string, TaskItem>, aliases: Map<string, string>, nowMs: number, now: string,
) {
  const cutoff = nowMs - 24 * HOUR;
  const fromAdapters = outputs.flatMap(output => output.timeline ?? [])
    .filter(segment => Date.parse(segment.startedAt) <= nowMs &&
      (segment.isActive || Date.parse(segment.endedAt) >= cutoff));
  const primary = new Set(fromAdapters.filter(s => !aliases.has(s.taskId)).map(s => s.taskId));
  const segments = fromAdapters.filter(s => !primary.has(aliases.get(s.taskId) ?? ''))
    .map(segment => {
      const taskId = aliases.get(segment.taskId) ?? segment.taskId;
      const task = taskById.get(taskId);
      const status = segment.isActive && task ? task.status : segment.status;
      const active = segment.isActive && isActive(status);
      const endedAt = active ? now : segment.isActive && task ? task.completedAt ?? task.updatedAt : segment.endedAt;
      return { ...segment, taskId, label: task?.title ?? segment.label, source: task?.source ?? segment.source,
        project: task?.project ?? segment.project, status, isActive: active, endedAt };
    });
  const represented = new Set(segments.map(segment => segment.taskId));
  const representedActive = new Set(segments.filter(segment => segment.isActive).map(segment => segment.taskId));
  const derived: TimelineSegment[] = [...taskById.values()].filter(task => !represented.has(task.id) ||
    (isActive(task.status) && !representedActive.has(task.id))).map(task => ({
    id: task.id, taskId: task.id, label: task.title, project: task.project, source: task.source,
    provider: task.provider, status: task.status, startedAt: task.startedAt,
    endedAt: isActive(task.status) ? now : task.completedAt ?? task.updatedAt, isActive: isActive(task.status),
  }));
  const sorted = [...segments, ...derived]
    .filter(segment => Date.parse(segment.startedAt) <= nowMs && Date.parse(segment.endedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) ||
      Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return uniqueBy(uniqueBy(sorted, s => s.id), s => JSON.stringify([s.taskId, s.startedAt])).slice(0, 40);
}

function buildAlerts(
  outputs: CollectorOutput[], taskById: Map<string, TaskItem>, aliases: Map<string, string>, nowMs: number,
) {
  const alerts = outputs.flatMap(output => output.alerts).map(alert => {
    const taskId = aliases.get(alert.taskId) ?? alert.taskId;
    const task = taskById.get(taskId);
    return { ...alert, taskId, source: task?.source ?? alert.source, sourceLabel: task?.sourceLabel ?? alert.sourceLabel,
      ageMs: Math.max(0, nowMs - Date.parse(alert.createdAt)) };
  });
  const covered = new Set(alerts.map(alert => JSON.stringify([alert.taskId, alert.kind])));
  for (const task of taskById.values()) {
    const completed = Date.parse(task.completedAt ?? task.updatedAt);
    const conditions: [AttentionAlert['kind'], boolean, AttentionAlert['severity'], string | undefined][] = [
      ['approval', task.pendingApprovals > 0, 'critical', task.currentStep],
      ['user_input', task.pendingInputs > 0, 'warning', task.currentStep],
      ['proposed_plan', task.hasActionablePlan, 'warning', task.currentStep],
      ['failed', task.status === 'failed' && completed >= nowMs - 6 * HOUR && completed <= nowMs,
        'critical', task.errorMessage],
      ['stale', !!task.isStale, 'warning', task.currentStep],
    ];
    for (const [kind, applies, severity, detail] of conditions) {
      if (!applies || covered.has(JSON.stringify([task.id, kind]))) continue;
      const createdAt = kind === 'failed' ? task.completedAt ?? task.updatedAt : task.updatedAt;
      alerts.push({
        id: kind + ':' + task.id, taskId: task.id, source: task.source, sourceLabel: task.sourceLabel,
        kind, severity, title: task.title, detail, project: task.project, branch: task.gitBranch,
        createdAt, ageMs: Math.max(0, nowMs - Date.parse(createdAt)), cwd: task.cwd,
      });
    }
  }
  return uniqueBy(alerts.sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt)), alert => alert.id);
}

function reconcileModelUsage(outputs: CollectorOutput[], midnight: number) {
  const reports = outputs.flatMap(output => (output.modelUsage ?? []).map(entry => ({
    entry: Date.parse(output.collectedAt) >= midnight ? entry : { ...entry, todayTokens: 0 },
    direct: entry.providerId === output.adapterId,
  })));
  const byUsage = (a: ModelUsageEntry, b: ModelUsageEntry) => b.tokens24h - a.tokens24h || b.todayTokens - a.todayTokens;
  reports.sort((a, b) => Number(b.direct) - Number(a.direct) || byUsage(a.entry, b.entry));
  return uniqueBy(reports, ({ entry }) => modelKey(entry.providerId, entry.model)).map(report => report.entry).sort(byUsage);
}

function reconcileQuotas(outputs: CollectorOutput[]) {
  const quotas = outputs.flatMap(output => output.quotas).sort((a, b) =>
    Number(a.sourceMode === 'local-only') - Number(b.sourceMode === 'local-only') ||
    (Date.parse(b.checkedAt ?? '') || 0) - (Date.parse(a.checkedAt ?? '') || 0));
  const measured = new Set(quotas.filter(quota => quota.sourceMode !== 'local-only').map(quota => quota.providerId));
  return uniqueBy(quotas, quota => JSON.stringify([quota.providerId, quota.windowId]))
    .filter(quota => quota.sourceMode !== 'local-only' || !measured.has(quota.providerId))
    .map(quota => ({ ...quota, remainingPercent: quota.sourceMode === 'local-only' ? undefined
      : Math.max(0, Math.min(100, 100 - quota.usedPercent)) }));
}

function updateTokens(
  outputs: CollectorOutput[], modelUsage: ModelUsageEntry[], tasks: TaskItem[], matches: Map<string, TaskItem>, history: ReconcilerHistory,
  nowMs: number, runningCount: number,
) {
  const now = new Date(nowMs).toISOString();
  const midnight = new Date(nowMs).setHours(0, 0, 0, 0);
  const previous = history.tokens;
  const daily = previous?.midnight === midnight ? previous.daily : new Map<string, DailyCounter>();
  const counters = new Map<string, number>();
  const keysBySourceTask = new Map<string, string>();
  let delta = 0;
  let todayTokens = 0;
  const models = new Set<string>();
  // T3 can record a selected alias while the native transcript records the serving model.
  // A provider's daily total includes both names for that session.
  const direct = new Set(outputs.filter(output => output.todayTokens !== undefined &&
    output.modelUsage?.some(entry => entry.providerId === output.adapterId)).map(output => output.adapterId));
  const covered = (provider: string, model?: string) => direct.has(provider) || models.has(modelKey(provider, model));
  for (const entry of modelUsage) {
    const key = modelKey(entry.providerId, entry.model);
    models.add(key);
    const last = previous?.midnight === midnight ? previous.counters.get(key) : undefined;
    delta += Math.max(0, entry.todayTokens - (last ?? entry.todayTokens));
    counters.set(key, entry.todayTokens);
    todayTokens += entry.todayTokens;
  }
  for (const task of tasks) {
    if (!task.tokens) continue;
    const key = 'task:' + (task.externalIds.codexThreadId ?? task.id);
    const native = matches.get(task.id);
    keysBySourceTask.set(native?.tokens ? native.id : task.id, key);
    if (native) {
      // A previously independent session may acquire its native ID on a later poll.
      if (key !== 'task:' + task.id) daily.delete('task:' + task.id);
      if (key !== 'task:' + native.id) daily.delete('task:' + native.id);
    }
    if (counters.has(key)) continue;
    const total = task.tokens.totalTokens;
    const started = Date.parse(task.startedAt);
    const last = previous?.counters.get(key) ?? (previous && started >= previous.observedAt ? 0 : total);
    const gained = Math.max(0, total - last);
    counters.set(key, total);
    if (!covered(task.provider, task.model)) delta += gained;
    // A lifetime counter from a session started yesterday is not a daily counter.
    daily.set(key, { provider: task.provider, model: task.model, total: started >= midnight ? total : (daily.get(key)?.total ?? 0) + gained });
  }

  const reportedTotals = new Map<string, number>();
  for (const output of outputs) {
    const reported = output.todayTokens !== undefined && Date.parse(output.collectedAt) >= midnight;
    const reportedModels = output.modelUsage ?? [];
    let overlap = reportedModels.reduce((sum, entry) => sum + entry.todayTokens, 0);
    for (const task of output.tasks) {
      if (!task.tokens) continue;
      const key = keysBySourceTask.get(task.id);
      if (key) daily.get(key)!.adapterId = output.adapterId;
      else if (reported && matches.has(task.id) && Date.parse(task.startedAt) >= midnight &&
        !reportedModels.some(entry => entry.providerId === task.provider && entry.model === task.model)) overlap += task.tokens.totalTokens;
    }
    if (reported) {
      const total = Math.max(0, output.todayTokens! - overlap);
      reportedTotals.set(output.adapterId, total);
      if (!output.tasks.some(task => task.tokens)) {
        const key = 'adapter:' + output.adapterId;
        const last = previous?.midnight === midnight ? previous.counters.get(key) : undefined;
        delta += Math.max(0, total - (last ?? total));
        counters.set(key, total);
      }
    }
  }
  for (const total of reportedTotals.values()) todayTokens += total;
  for (const { total, adapterId, provider, model } of daily.values()) {
    if (adapterId && !reportedTotals.has(adapterId) && !covered(provider, model)) todayTokens += total;
  }
  let pending = (previous?.pending ?? 0) + delta;
  let bucketStart = previous?.bucketStart ?? nowMs;
  let points = previous?.points ?? [{ timestamp: now, tokensPerMin: 0, activeTasks: runningCount }];
  const elapsed = nowMs - bucketStart;
  if (elapsed >= TOKEN_BUCKET_MS) {
    points = [...points, {
      timestamp: now, tokensPerMin: Math.round(pending * 60_000 / elapsed), activeTasks: runningCount,
    }].slice(-60);
    bucketStart = nowMs;
    pending = 0;
  }
  history.tokens = { observedAt: nowMs, bucketStart, pending, counters, points, midnight, daily };
  return { todayTokens, tokenHistory: points };
}

export function reconcileOutputs(
  outputs: CollectorOutput[],
  { nowMs = Date.now(), staleThresholdMs, serverVersion, history = {}, todos = [], tokenActivity }: {
    nowMs?: number; staleThresholdMs: number; serverVersion: string; history?: ReconcilerHistory; todos?: TodoItem[]; tokenActivity?: TokenActivityPayload;
  },
): OrrerySnapshot {
  const now = new Date(nowMs).toISOString();
  const { tasks: joined, matches, aliases, childIds } = joinSources(outputs);
  const ownerOf = (task: TaskItem) => matches.has(task.id) ? 't3' : agentId(task);
  const newest = [...outputs].sort((a, b) => Date.parse(b.collectedAt) - Date.parse(a.collectedAt));
  const processSamples = newest.filter(output => output.processes !== undefined);
  const processes = uniqueBy(processSamples.flatMap(output => output.processes ?? []), p => p.pid);
  const runtimeById = new Map(uniqueBy(outputs.flatMap(output => output.agents), agent => agent.id)
    .map(agent => [agent.id, agent]));
  const names: Record<string, string> = { t3: 'T3 Code', codex: 'Codex', antigravity: 'Antigravity', 'claude-code': 'Claude Code', opencode: 'OpenCode' };
  for (const proc of processes) {
    if (runtimeById.has(proc.agentId)) continue;
    runtimeById.set(proc.agentId, {
      id: proc.agentId, name: names[proc.agentId] ?? proc.agentId, status: 'online',
      lastSeenAt: processSamples[0].collectedAt, runningCount: 0, waitingCount: 0, queuedCount: 0,
      subagentCount: 0, cpuPercent: 0, memoryMb: 0, processCount: 0, pids: [],
    });
  }
  const liveIds = new Set(processes.map(proc => proc.agentId));
  const tasks = joined.map(task => {
    const owner = ownerOf(task);
    const runtime = runtimeById.get(owner);
    const noProcess = processSamples.length ? !liveIds.has(owner) : runtime && !runtime.processCount && !runtime.pids.length;
    let status = task.status;
    if (task.pendingApprovals > 0) status = 'waiting_approval';
    else if (task.pendingInputs > 0) status = 'waiting_input';
    else if (status === 'running' && (task.isStale || noProcess || nowMs - Date.parse(task.updatedAt) > staleThresholdMs)) status = 'stale';
    return { ...task, status, isStale: status === 'stale',
      durationMs: isActive(status) ? Math.max(0, nowMs - Date.parse(task.startedAt)) : task.durationMs };
  });
  const rank = (task: TaskItem) => isActive(task.status) ? 0 : task.status === 'queued' ? 1 : 2;
  tasks.sort((a, b) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const scheduled = uniqueBy(newest.flatMap(output => output.scheduled), item => item.id);
  const queuedTasks = tasks.filter(task => task.status === 'queued');
  const queuedIds = new Set(queuedTasks.map(task => task.id));
  const queuedItems = scheduled.filter(item => item.kind === 'queued_item' && item.status === 'queued' && !queuedIds.has(item.id));

  const metricsHistory = history.agents ??= new Map();
  const agents: AgentRuntime[] = [...runtimeById.values()].map(agent => {
    const owned = tasks.filter(task => ownerOf(task) === agent.id);
    const procs = processes.filter(proc => proc.agentId === agent.id);
    const cpuPercent = processSamples.length ? procs.reduce((sum, proc) => sum + proc.cpuPercent, 0) : agent.cpuPercent;
    const memoryMb = processSamples.length ? procs.reduce((sum, proc) => sum + proc.memoryMb, 0) : agent.memoryMb;
    const collectedAt = processSamples[0]?.collectedAt ?? agent.lastSeenAt;
    let samples = metricsHistory.get(agent.id);
    if (!samples || collectedAt !== samples.collectedAt) {
      samples = { collectedAt, cpu: [...(samples?.cpu ?? []), cpuPercent].slice(-30),
        memory: [...(samples?.memory ?? []), memoryMb].slice(-30) };
      metricsHistory.set(agent.id, samples);
    }
    return { ...agent, cpuPercent, memoryMb, pids: processSamples.length ? procs.map(proc => proc.pid) : agent.pids,
      processCount: processSamples.length ? procs.length : agent.processCount, cpuHistory: samples.cpu, memoryHistory: samples.memory,
      runningCount: owned.filter(task => task.status === 'running').length, waitingCount: owned.filter(task => isWaiting(task.status)).length,
      queuedCount: owned.filter(task => task.status === 'queued').length + queuedItems.filter(item => item.source === agent.id).length,
      subagentCount: uniqueSubagents(owned.flatMap(task => task.subagents), childIds).filter(node => isActive(node.status)).length };
  });

  const runningCount = tasks.filter(task => task.status === 'running').length;
  const modelUsage = reconcileModelUsage(newest, new Date(nowMs).setHours(0, 0, 0, 0));
  const { todayTokens, tokenHistory } = updateTokens(outputs, modelUsage, tasks, matches, history, nowMs, runningCount);
  const taskById = new Map<string, TaskItem>(tasks.map(task => [task.id, task]));
  const events = latestEvents(outputs.flatMap(output => output.events)).map(event => {
      const taskId = event.taskId && (aliases.get(event.taskId) ?? event.taskId);
      const task = taskId && taskById.get(taskId);
      return task ? { ...event, taskId, source: task.source, taskTitle: task.title } : event;
    });
  const recent = tasks.filter(task => {
    const end = Date.parse(task.completedAt ?? task.updatedAt);
    return end >= nowMs - 24 * HOUR && end <= nowMs;
  });
  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();
  const alerts = buildAlerts(outputs, taskById, aliases, nowMs);
  const timeline = buildTimeline(outputs, taskById, aliases, nowMs, now);
  history.tasksById = taskById;
  for (const [alias, id] of aliases) taskById.set(alias, taskById.get(id)!);
  return {
    generatedAt: now, serverVersion, agents, processes, tasks: tasks.slice(0, 80), events, alerts, timeline, scheduled, todos, tokenHistory,
    ...(tokenActivity ? { tokenActivity } : {}),
    summary: {
      runningCount, waitingCount: tasks.filter(task => isWaiting(task.status)).length,
      queuedCount: queuedTasks.length + queuedItems.length,
      failed24hCount: recent.filter(task => task.status === 'failed').length,
      completed24hCount: recent.filter(task => task.status === 'completed').length, todayTokens,
      activeSubagents: uniqueSubagents(tasks.flatMap(task => task.subagents), childIds).filter(node => isActive(node.status)).length,
    },
    quotas: reconcileQuotas(newest), modelUsage,
    host: newest.find(output => output.host)?.host ?? {
      cpuPercent: 0, memoryUsedGb: usedMemory / 1024 ** 3, memoryTotalGb: totalMemory / 1024 ** 3,
      memoryPercent: 100 * usedMemory / totalMemory, agentProcessCount: processes.length, uptimeSec: os.uptime(), collectedAt: now,
    },
  };
}
