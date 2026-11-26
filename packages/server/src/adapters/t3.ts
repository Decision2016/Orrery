import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AttentionAlert, EventEntry, SubagentNode, TaskItem, TaskStep, TokenMetrics } from '@orrery/shared';
import type { OrreryConfig } from '../config.js';
import type { CollectorAdapter } from './types.js';
import { cachedQuotaWindows, dayMs, summarizeUsage, type UsageSample } from './usage.js';
import {
  agentRuntime, brief, collectorOutput, normalizeWindowsPath, numberValue, parseJson, readJsonFile,
  readFields, readRows, record, stringValue, tableColumns, taskStatus, timestamp, tokenMetrics, withReadOnlyDb,
} from './sqlite.js';

const projection = 'orchestration_v2_projection_';
const liveStatuses = ['running', 'starting', 'preparing', 'waiting', 'waiting_approval', 'waiting_input', 'queued'];
const isLive = (value: unknown) => liveStatuses.includes(String(value));
const weekdays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const usageProviderNames: Record<string, string> = { claudeAgent: 'Claude', deepseek: 'DeepSeek', grok: 'Grok', pi: 'Pi', opencode: 'OpenCode' };

function readSteps(db: DatabaseSync, threadId: string, runId: string, fallbackTime: string, itemColumns: Set<string>): TaskStep[] {
  const nodeId = itemColumns.has('node_id') ? 'node_id' : 'NULL AS node_id';
  const display = itemColumns.has('payload_json') ? `
    CASE WHEN json_valid(payload_json) THEN json_object(
      'label', coalesce(json_extract(payload_json, '$.toolName'), json_extract(payload_json, '$.title')),
      'startedAt', json_extract(payload_json, '$.startedAt'), 'completedAt', json_extract(payload_json, '$.completedAt')
    ) END` : 'NULL';
  const items = readRows(db, `SELECT turn_item_id, ${nodeId}, type, status, updated_at, ${display} AS display_json
    FROM ${projection}turn_items WHERE thread_id = ? AND run_id = ? ORDER BY updated_at DESC LIMIT 15`, threadId, runId);
  const nodes = readRows(db, `SELECT node_id, kind, status, started_at, completed_at FROM ${projection}nodes
    WHERE thread_id = ? AND run_id = ? AND kind != 'root_turn' ORDER BY started_at DESC LIMIT 15`, threadId, runId);
  const represented = new Set(items.map(item => item.node_id));
  const steps = [
    ...items.map(item => {
      const display = record(parseJson(item.display_json));
      return { id: item.turn_item_id, type: String(item.type), label: brief(display.label), status: item.status,
        start: timestamp(display.startedAt) ?? timestamp(item.updated_at), end: timestamp(display.completedAt), updated: timestamp(item.updated_at) };
    }),
    ...nodes.filter(node => !represented.has(node.node_id)).map(node => ({
      id: node.node_id, type: String(node.kind), label: undefined, status: node.status,
      start: timestamp(node.started_at), end: timestamp(node.completed_at), updated: timestamp(node.completed_at) ?? timestamp(node.started_at),
    })),
  ];
  return steps.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')).slice(0, 15).map(step => {
    const status = taskStatus(step.status, 'completed');
    const kind = /command|shell/.test(step.type) ? 'command' : /reasoning|thought/.test(step.type) ? 'reasoning'
      : /approval|request/.test(step.type) ? 'approval' : /subagent/.test(step.type) ? 'subagent'
      : /tool|file_change|search/.test(step.type) ? 'tool_call' : /error/.test(step.type) ? 'error' : 'message';
    return {
      id: String(step.id), kind, label: step.label ?? step.type.replaceAll('_', ' '),
      status: status === 'running' ? 'running' : status.startsWith('waiting') || status === 'queued' ? 'waiting'
        : status === 'failed' ? 'failed' : 'completed',
      startedAt: step.start ?? fallbackTime, completedAt: step.end,
    };
  });
}

async function readQuotas(dir: string) {
  const names = await readdir(dir).catch(() => []);
  const files = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
    const cache = record(await readJsonFile(path.join(dir, name)));
    return cachedQuotaWindows(cache, path.basename(name, '.json'));
  }));
  return files.flat();
}

export class T3Adapter implements CollectorAdapter {
  readonly id = 't3';
  readonly name = 'T3 Code';
  readonly intervalMs: number;
  private lastSequence?: number;
  private usageRevision?: string;
  private usage = new Map<string, TokenMetrics>();
  private modelSamples: UsageSample[] = [];
  private modelSummary?: ReturnType<typeof summarizeUsage>;

  constructor(private readonly config: OrreryConfig) {
    this.intervalMs = config.pollIntervalMs;
  }

  private async readUsage(now: number) {
    const file = path.join(this.config.t3UserDataDir, 'usage-scan-cache-v17.json');
    const info = await stat(file).catch(() => undefined);
    if (!info) {
      this.usage.clear();
      this.usageRevision = undefined;
      this.modelSamples = [];
      this.modelSummary = undefined;
      return [];
    }
    const revision = `${info.mtimeMs}:${info.size}`;
    if (this.modelSummary && now >= this.modelSummary.validUntil) this.modelSummary = summarizeUsage(this.modelSamples, now);
    if (revision === this.usageRevision) return this.modelSummary?.entries ?? [];
    const cache = record(await readJsonFile(file));
    if (cache.version !== 17 || !Array.isArray(cache.sessions)) return this.modelSummary?.entries ?? [];
    const sessions: unknown[] = cache.sessions;
    const models: unknown[] = Array.isArray(cache.models) ? cache.models : [];
    const usage = new Map<string, TokenMetrics>();
    const samples: UsageSample[] = [];
    const seenByProvider = new Map<string | undefined, Set<string>>();
    for (const raw of Object.values(record(cache.files))) {
      const entry = record(raw);
      const providerId = entry.p === 'claude' ? 'claudeAgent' : stringValue(entry.p);
      const seen = seenByProvider.get(providerId) ?? new Set<string>();
      seenByProvider.set(providerId, seen);
      const modelProvider = providerId && providerId !== 'codex' && providerId !== 'antigravity'
        && (numberValue(entry.m) ?? now) >= now - dayMs ? providerId : undefined;
      for (const bucket of [entry.r, entry.t]) {
        if (!Array.isArray(bucket)) continue;
        for (const row of bucket) {
          if (!Array.isArray(row)) continue;
          // v17 interns session IDs and stores token deltas, including cached and cache-write input.
          const [time, modelIndex, sessionIndex, uncached, cached, creation, output, reasoning, dedupeKey] = row;
          const id = stringValue(sessions[sessionIndex]);
          if (!id || (typeof dedupeKey === 'string' && seen.has(dedupeKey))) continue;
          if (typeof dedupeKey === 'string') seen.add(dedupeKey);
          const totals = usage.get(id) ?? tokenMetrics();
          const input = (numberValue(uncached) ?? 0) + (numberValue(creation) ?? 0);
          const cacheRead = numberValue(cached) ?? 0;
          const generated = numberValue(output) ?? 0;
          const total = input + cacheRead + generated;
          totals.inputTokens += input + cacheRead;
          totals.cachedInputTokens += cacheRead;
          totals.outputTokens += generated;
          totals.reasoningTokens += numberValue(reasoning) ?? 0;
          totals.totalTokens += total;
          usage.set(id, totals);
          if (modelProvider) {
            const at = numberValue(time);
            const model = stringValue(models[modelIndex]);
            if (at !== undefined && at >= now - dayMs && model) samples.push({
              providerId: modelProvider, providerName: usageProviderNames[modelProvider] ?? modelProvider,
              model, sessionId: id, at, input, cached: cacheRead, output: generated, total,
            });
          }
        }
      }
    }
    this.usage = usage;
    this.usageRevision = revision;
    this.modelSamples = samples;
    this.modelSummary = summarizeUsage(samples, now);
    return this.modelSummary.entries;
  }

  async collect() {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const result = collectorOutput(this.id, at);
    result.timeline = [];
    const [metadata, quotas, modelUsage] = await Promise.all([
      readJsonFile(path.join(this.config.t3UserDataDir, 'server-runtime.json')),
      readQuotas(this.config.t3CachesDir), this.readUsage(now),
    ]);
    result.quotas = quotas;
    result.modelUsage = modelUsage;
    const hours = numberValue(this.config.recentWindowHours) ?? 24;
    const windowStart = now - Math.max(0, hours) * 3_600_000;
    const cutoff = new Date(Math.min(windowStart, now - dayMs)).toISOString();
    const available = withReadOnlyDb(path.join(this.config.t3UserDataDir, 'statev2.sqlite'), db => {
      const projects = new Map(readRows(db, 'SELECT project_id, title, workspace_root FROM projection_projects')
        .map(row => [row.project_id, row]));
      const runs = readRows(db, `SELECT * FROM ${projection}runs WHERE requested_at >= ? OR completed_at >= ?
        OR status IN (SELECT value FROM json_each(?)) ORDER BY requested_at DESC`, cutoff, cutoff, JSON.stringify(liveStatuses));
      const requests = readRows(db, `SELECT * FROM ${projection}runtime_requests WHERE status = 'pending'`);
      const plans = readRows(db, `SELECT * FROM ${projection}plans WHERE
        (kind IN ('proposed_plan','proposal') AND status IN ('active','pending','proposed','pending_approval'))
        OR status IN ('proposed','pending_approval')`);
      const latestThreads = readRows(db, `SELECT * FROM ${projection}threads WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 80`);
      const displayIds = new Set([...latestThreads, ...runs.filter(row => isLive(row.status)), ...requests, ...plans]
        .map(row => String(row.thread_id)));
      const knownIds = new Set(latestThreads.map(row => String(row.thread_id)));
      const otherIds = [...new Set([...displayIds, ...runs.map(run => String(run.thread_id))])].filter(id => !knownIds.has(id));
      const threads = [...latestThreads, ...(otherIds.length ? readRows(db, `SELECT * FROM ${projection}threads
        WHERE deleted_at IS NULL AND thread_id IN (SELECT value FROM json_each(?))`, JSON.stringify(otherIds)) : [])];
      const selectedIds = JSON.stringify([...displayIds]);
      const providers = readRows(db, `SELECT * FROM ${projection}provider_threads WHERE thread_id IN (SELECT value FROM json_each(?))
        ORDER BY updated_at DESC`, selectedIds);
      const itemColumns = tableColumns(db, projection + 'turn_items');
      const subagents = readRows(db, `SELECT s.*, child.title AS child_title FROM ${projection}subagents s
        LEFT JOIN ${projection}threads child ON child.thread_id = s.child_thread_id
        WHERE s.thread_id IN (SELECT value FROM json_each(?)) ORDER BY s.started_at DESC`, selectedIds);
      const childSubagents = new Map(readRows(db, `SELECT child_thread_id, status, started_at, completed_at
        FROM ${projection}subagents WHERE child_thread_id IN (SELECT value FROM json_each(?))
        ORDER BY updated_at DESC`, selectedIds).map(row => [String(row.child_thread_id), row]));

      for (const thread of threads.filter(row => displayIds.has(String(row.thread_id)))) {
        const id = String(thread.thread_id);
        const payload = record(parseJson(thread.payload_json));
        const project = projects.get(thread.project_id);
        const candidates = runs.filter(run => run.thread_id === id);
        const run = candidates.find(run => isLive(run.status) && run.status !== 'queued')
          ?? candidates.find(run => run.status === 'queued') ?? candidates[0]
          ?? readRows(db, `SELECT * FROM ${projection}runs WHERE thread_id = ? ORDER BY requested_at DESC LIMIT 1`, id)[0];
        const subagentSelf = childSubagents.get(id);
        const runPayload = record(parseJson(run?.payload_json));
        const runId = stringValue(run?.run_id);
        const model = record(runPayload.modelSelection ?? payload.modelSelection);
        const options = Array.isArray(model.options) ? model.options.map(record) : [];
        const bindings = providers.filter(row => row.thread_id === id);
        const binding = bindings.find(row => row.provider_thread_id === thread.active_provider_thread_id)
          ?? bindings.find(row => row.provider_thread_id === run?.provider_thread_id) ?? bindings[0];
        const bindingPayload = record(parseJson(binding?.payload_json));
        const native = record(bindingPayload.nativeThreadRef);
        const driver = stringValue(binding?.driver ?? bindingPayload.driver ?? native.driver ?? binding?.provider ?? run?.provider ?? thread.default_provider) ?? 't3';
        const nativeId = stringValue(native.nativeId);
        const usage = record(bindingPayload.contextUsage);
        const used = numberValue(usage.usedTokens);
        const max = numberValue(usage.maxTokens);
        const cached = nativeId ? this.usage.get(nativeId) : undefined;
        const tokens = cached ? { ...cached } : used !== undefined || max !== undefined ? tokenMetrics(used) : undefined;
        if (tokens && max && max > 0) {
          tokens.contextWindow = max;
          if (used !== undefined) tokens.contextPercent = Math.min(100, Math.max(0, used / max * 100));
        }
        const startedAt = timestamp(runPayload.startedAt ?? run?.requested_at ?? subagentSelf?.started_at ?? thread.created_at) ?? at;
        const completedAt = timestamp(run?.completed_at ?? subagentSelf?.completed_at);
        const updatedAt = [timestamp(thread.updated_at), completedAt, timestamp(binding?.updated_at), startedAt]
          .filter((value): value is string => !!value).sort().at(-1) ?? startedAt;
        const status = taskStatus(run?.status ?? subagentSelf?.status ?? binding?.status, 'completed');
        const steps = runId && (isLive(run.status) || Date.parse(completedAt ?? startedAt) >= windowStart)
          ? readSteps(db, id, runId, startedAt, itemColumns) : [];
        const children: SubagentNode[] = subagents.filter(row => row.thread_id === id).map(row => {
          const data = record(parseJson(row.payload_json));
          const start = timestamp(row.started_at) ?? startedAt;
          const end = timestamp(row.completed_at);
          return {
            id: String(row.subagent_id), parentId: stringValue(row.parent_node_id), childThreadId: stringValue(row.child_thread_id),
            title: brief(row.child_title) ?? brief(data.title) ?? 'Subagent', provider: stringValue(row.driver ?? row.provider) ?? driver,
            model: stringValue(data.model ?? record(data.modelSelection).model), status: taskStatus(row.status),
            currentStep: brief(data.currentStep), origin: stringValue(row.origin ?? data.origin ?? data.createdBy),
            startedAt: start, completedAt: end, durationMs: Math.max(0, (end ? Date.parse(end) : now) - Date.parse(start)),
          };
        });
        const worktreePath = normalizeWindowsPath(stringValue(payload.worktreePath));
        const task: TaskItem = {
          id: `t3:${id}`, externalIds: { t3ThreadId: id, t3RunId: runId, t3ProviderThreadId: stringValue(binding?.provider_thread_id),
            codexThreadId: driver === 'codex' ? nativeId : undefined },
          source: 't3', sourceLabel: 'T3 Code', title: brief(thread.title) ?? (payload.createdBy === 'agent' ? 'Agent thread' : 'Untitled thread'),
          status, project: stringValue(project?.title), cwd: worktreePath ?? normalizeWindowsPath(stringValue(project?.workspace_root)),
          gitBranch: stringValue(payload.branch), worktreePath, provider: driver, model: stringValue(model.model),
          reasoningEffort: stringValue(options.find(o => o.id === 'reasoningEffort')?.value ?? record(model.options).reasoningEffort),
          runtimeMode: stringValue(thread.runtime_mode ?? payload.runtimeMode), recentSteps: steps,
          currentStep: (steps.find(step => step.status === 'running') ?? steps[0])?.label,
          startedAt, updatedAt, completedAt, durationMs: Math.max(0, Date.parse(completedAt ?? (isLive(run?.status) ? at : updatedAt)) - Date.parse(startedAt)),
          tokens, pendingApprovals: 0, pendingInputs: 0, hasActionablePlan: false,
          linkedPrUrl: stringValue(record(payload.linkedPullRequest).url ?? payload.linkedPullRequest),
          subagents: children, errorMessage: brief(runPayload.errorMessage ?? record(runPayload.error).message), isStale: status === 'stale',
        };
        const alert = (key: string, kind: AttentionAlert['kind'], title: string, createdAt: string, detail?: string) => {
          result.alerts.push({ id: `t3:${kind}:${key}`, taskId: task.id, source: task.source, sourceLabel: task.sourceLabel,
            kind, severity: 'warning', title, detail, project: task.project, branch: task.gitBranch,
            createdAt, ageMs: Math.max(0, now - Date.parse(createdAt)), cwd: task.cwd });
        };
        for (const request of requests.filter(row => row.thread_id === id)) {
          const data = record(parseJson(request.payload_json));
          const input = /input|question|elicitation/i.test(String(request.kind));
          if (input) task.pendingInputs++;
          else task.pendingApprovals++;
          alert(String(request.runtime_request_id), input ? 'user_input' : 'approval',
            input ? 'User input requested' : 'Approval requested', timestamp(request.created_at) ?? updatedAt,
            brief(data.title ?? data.question ?? data.description) ?? task.title);
        }
        if (task.pendingApprovals) task.status = 'waiting_approval';
        else if (task.pendingInputs) task.status = 'waiting_input';
        task.isStale = task.status === 'stale';
        const plan = plans.find(row => row.thread_id === id);
        const proposed = record(payload.proposedPlan);
        const reviewable = proposed.actionable !== false && (['active','proposed','pending','pending_approval'].includes(String(proposed.status))
          || (!proposed.status && (stringValue(proposed.markdown) || proposed.actionable === true)));
        if (plan || payload.hasActionablePlan === true || stringValue(payload.proposedPlan) || reviewable) {
          task.hasActionablePlan = true;
          alert(stringValue(plan?.plan_id) ?? id, 'proposed_plan', 'Proposed plan ready for review', updatedAt, task.title);
        }
        result.tasks.push(task);
      }

      const byId = new Map(threads.map(row => [row.thread_id, row]));
      const taskById = new Map(result.tasks.map(task => [task.externalIds.t3ThreadId, task]));
      result.timeline = runs.flatMap(run => {
        const thread = byId.get(run.thread_id);
        if (!thread) return [];
        const task = taskById.get(String(run.thread_id));
        const start = timestamp(record(parseJson(run.payload_json)).startedAt ?? run.requested_at);
        const active = isLive(run.status);
        const end = timestamp(run.completed_at) ?? (active ? at : start);
        if (!start || !end || Date.parse(end) < now - dayMs) return [];
        return [{ id: `t3:run:${run.run_id}`, taskId: `t3:${run.thread_id}`, label: brief(thread.title) ?? 'T3 thread',
          project: stringValue(projects.get(thread.project_id)?.title), source: 't3' as const, provider: stringValue(run.provider) ?? 't3',
          status: task?.externalIds.t3RunId === run.run_id ? task.status : taskStatus(run.status), startedAt: start, endedAt: end, isActive: active }];
      });
      result.scheduled = readFields(db, 'scheduled_tasks', ['task_id','title','enabled','schedule_json','project_id','next_run_at',
        'last_run_at','last_run_status','last_run_error','run_count','model_selection_json']).map(row => {
        const schedule = record(parseJson(row.schedule_json));
        const days = Array.isArray(schedule.weekdays) ? schedule.weekdays.filter(day =>
          Number.isInteger(day) && day >= 0 && day <= 6).map(day => weekdays[day]).join(', ') : 'Daily';
        const everyMs = numberValue(schedule.everyMs);
        const scheduleText = schedule.type === 'interval' && everyMs ? `Every ${everyMs / 60_000} min`
          : schedule.type === 'fixed_time' ? `${days} ${stringValue(schedule.timeOfDay) ?? ''}`.trim()
          : schedule.type === 'once' ? timestamp(schedule.runAt) : schedule.type === 'webhook' ? 'Webhook'
          : brief(schedule.expression ?? schedule.cron ?? schedule.rrule ?? schedule.description ?? schedule.kind ?? schedule.type);
        return {
          id: `t3:schedule:${row.task_id}`, source: 't3', kind: 'scheduled_task', title: brief(row.title) ?? 'Scheduled task',
          status: row.enabled ? 'enabled' : 'paused',
          scheduleText,
          nextRunAt: timestamp(row.next_run_at), lastRunAt: timestamp(row.last_run_at), lastRunStatus: stringValue(row.last_run_status),
          lastError: brief(row.last_run_error), runCount: numberValue(row.run_count), model: stringValue(record(parseJson(row.model_selection_json)).model),
          cwd: normalizeWindowsPath(stringValue(projects.get(row.project_id)?.workspace_root)),
        };
      });
      const head = readRows(db, 'SELECT max(sequence) AS sequence FROM orchestration_v2_events')[0];
      if (!head) return true;
      const sequence = numberValue(head.sequence) ?? 0;
      const events = this.lastSequence === undefined || this.lastSequence > sequence
        ? readRows(db, 'SELECT * FROM orchestration_v2_events ORDER BY sequence DESC LIMIT 80').reverse()
        : readRows(db, 'SELECT * FROM orchestration_v2_events WHERE sequence > ? ORDER BY sequence LIMIT 200', this.lastSequence);
      for (const row of events) {
        const data = record(parseJson(row.payload_json));
        const type = stringValue(row.event_type) ?? 'event';
        const level: EventEntry['level'] = /fail|error/i.test(type) ? 'error' : /request|warn|interrupt/i.test(type) ? 'warn'
          : /tool|command/i.test(type) ? 'tool' : /complete|finish/i.test(type) ? 'done' : 'info';
        const threadId = stringValue(row.thread_id);
        result.events.push({ id: `t3:event:${row.event_id ?? row.sequence}`, timestamp: timestamp(row.occurred_at) ?? at,
          source: 't3', level, taskId: threadId ? `t3:${threadId}` : undefined, taskTitle: taskById.get(threadId)?.title,
          summary: brief(data.title ?? data.summary) ?? type, detail: brief(data.message ?? data.detail) });
      }
      this.lastSequence = numberValue(events.at(-1)?.sequence) ?? sequence;
      return true;
    });
    const runtime = record(metadata);
    const pid = numberValue(runtime.pid);
    const port = numberValue(runtime.port);
    const host = stringValue(runtime.host) ?? '127.0.0.1';
    const started = timestamp(runtime.startedAt);
    const agent = agentRuntime(this.id, this.name, metadata && available ? 'online' : available || metadata ? 'degraded' : 'offline', at, result.tasks);
    agent.version = stringValue(runtime.serverVersion);
    agent.endpointUrl = stringValue(runtime.origin) ?? (port ? `http://${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${port}` : undefined);
    agent.detail = started ? `Started ${started}` : undefined;
    agent.pids = pid ? [pid] : [];
    agent.processCount = agent.pids.length;
    result.agents.push(agent);
    return result;
  }
}
