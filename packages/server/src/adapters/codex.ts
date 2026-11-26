import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EventEntry, QuotaWindow, ScheduledItem, SourceKind, TaskItem, TaskStatus, TaskStep, TokenMetrics } from '@orrery/shared';
import type { OrreryConfig } from '../config.js';
import type { CollectorAdapter, CollectorOutput } from './types.js';
import { dayMs, summarizeUsage, type UsageSample } from './usage.js';
import {
  agentRuntime, brief, collectorOutput, normalizeWindowsPath, numberValue, parseJson, readFields, readRows,
  record, stringValue, tableColumns, taskStatus, timestamp, tokenMetrics, withReadOnlyDb,
} from './sqlite.js';

const halfHour = 30 * 60_000;
const labels = { 'codex-cli': 'Codex CLI', 'codex-app': 'Codex App', 't3-codex': 'T3 → Codex' };

function sourceOf(originator: unknown, source: unknown): keyof typeof labels {
  const origin = stringValue(originator) ?? '';
  if (/^t3 code$/i.test(origin)) return 't3-codex';
  if (/desktop|app[-_ ]server/i.test(origin)) return 'codex-app';
  return /(?:^|[-_ /"])(?:cli|tui|exec)(?:$|[-_ /"])/i.test(`${origin} ${stringValue(source) ?? ''}`) ? 'codex-cli' : 'codex-app';
}

type Rollout = {
  taskId: string;
  ino: number;
  offset: number;
  lineStart: number;
  fragments: Buffer[];
  steps: TaskStep[];
  samples: (Pick<UsageSample, 'at' | 'input' | 'cached' | 'output' | 'total'> & { model?: string })[];
  quotas: QuotaWindow[];
  followed: boolean;
  mtimeMs: number;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  status?: TaskStatus;
  tokens?: TokenMetrics;
  model?: string;
  cwd?: string;
  effort?: string;
  contextWindow?: number;
};

function consumeLine(tail: Rollout, line: Buffer, taskId: string, source: SourceKind, title: string, events: EventEntry[], now: number) {
  const envelope = record(parseJson(line.toString('utf8')));
  const time = timestamp(envelope.timestamp);
  if (!time) return;
  const data = record(envelope.payload);
  const id = `${taskId}:rollout:${time}:${tail.lineStart}`;
  let summary: string | undefined;
  let level: EventEntry['level'] = 'info';
  if (envelope.type === 'turn_context') {
    tail.model = stringValue(data.model) ?? tail.model;
    tail.effort = stringValue(data.effort) ?? tail.effort;
    tail.cwd = normalizeWindowsPath(stringValue(data.cwd)) ?? tail.cwd;
    tail.contextWindow = numberValue(data.model_context_window) ?? tail.contextWindow;
    summary = 'Turn context updated';
  } else if (envelope.type === 'event_msg') {
    switch (data.type) {
      case 'token_count': {
        const limits = record(data.rate_limits);
        const quotas = (['primary', 'secondary'] as const).flatMap((windowId): QuotaWindow[] => {
          const window = record(limits[windowId]);
          const used = numberValue(window.used_percent);
          if (used === undefined) return [];
          const usedPercent = Math.max(0, Math.min(100, used));
          return [{ providerId: 'codex', providerName: 'Codex', windowId, label: windowId === 'primary' ? 'Primary' : 'Secondary',
            usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: numberValue(window.window_minutes),
            planType: stringValue(limits.plan_type), resetsAt: timestamp(window.resets_at), checkedAt: time, sourceMode: 'passive-log' }];
        });
        if (quotas.length && time >= (tail.quotas[0]?.checkedAt ?? '')) tail.quotas = quotas;
        const info = record(data.info);
        const total = record(info.total_token_usage);
        if (!Object.keys(total).length) return;
        const input = numberValue(total.input_tokens) ?? 0;
        const output = numberValue(total.output_tokens) ?? 0;
        const last = record(info.last_token_usage);
        const window = numberValue(info.model_context_window) ?? tail.contextWindow;
        const used = numberValue(last.total_tokens) ?? numberValue(last.input_tokens);
        tail.contextWindow = window;
        const totalTokens = numberValue(total.total_tokens) ?? input + output;
        const cachedInputTokens = numberValue(total.cached_input_tokens) ?? 0;
        const previous = tail.tokens && tail.tokens.totalTokens <= totalTokens ? tail.tokens : undefined;
        const delta = totalTokens - (previous?.totalTokens ?? 0);
        const at = Date.parse(time);
        if (delta > 0 && at >= now - dayMs) {
          const cached = Math.max(0, cachedInputTokens - (previous?.cachedInputTokens ?? 0));
          // Codex includes cache reads in input_tokens. Keep the model breakdown additive.
          tail.samples.push({ model: tail.model, at,
            input: Math.max(0, input - (previous?.inputTokens ?? 0) - cached), cached,
            output: Math.max(0, output - (previous?.outputTokens ?? 0)), total: delta });
        }
        tail.tokens = {
          inputTokens: input, cachedInputTokens, outputTokens: output,
          reasoningTokens: numberValue(total.reasoning_output_tokens) ?? 0, totalTokens,
          contextWindow: window, contextPercent: window && window > 0 && used !== undefined ? Math.min(100, Math.max(0, used / window * 100)) : undefined,
        };
        summary = 'Token usage updated';
        break;
      }
      case 'task_started':
        tail.status = 'running';
        tail.startedAt = timestamp(data.started_at) ?? time;
        tail.completedAt = undefined;
        tail.contextWindow = numberValue(data.model_context_window) ?? tail.contextWindow;
        summary = 'Turn started';
        break;
      case 'task_complete': case 'task_completed': case 'turn_aborted': case 'task_failed':
        tail.status = data.type === 'turn_aborted' ? 'interrupted' : data.type === 'task_failed' ? 'failed' : 'completed';
        tail.completedAt = timestamp(data.completed_at) ?? time;
        tail.steps.filter(step => step.status === 'running').forEach(step => {
          step.status = tail.status === 'failed' ? 'failed' : 'completed';
          step.completedAt = tail.completedAt;
        });
        summary = `Turn ${tail.status}`;
        level = tail.status === 'failed' ? 'error' : tail.status === 'interrupted' ? 'warn' : 'done';
        break;
      default: return;
    }
  } else if (envelope.type === 'response_item') {
    const callId = stringValue(data.call_id ?? data.id);
    if (data.type === 'custom_tool_call_output' || data.type === 'function_call_output') {
      const step = callId && tail.steps.find(step => step.id === `${taskId}:call:${callId}`);
      if (!step) return;
      step.status = 'completed';
      step.completedAt = time;
      summary = `${step.label} completed`;
      level = 'done';
    } else if (data.type === 'reasoning' || data.type === 'custom_tool_call' || data.type === 'function_call') {
      const reasoning = data.type === 'reasoning';
      const name = stringValue(data.name) ?? 'Tool call';
      summary = reasoning ? 'Reasoning' : brief(name);
      level = reasoning ? 'info' : 'tool';
      const previous = tail.steps[0];
      if (previous?.kind === 'reasoning' && previous.status === 'running') {
        previous.status = 'completed';
        previous.completedAt = time;
      }
      const finished = data.status === 'completed';
      const kind = reasoning ? 'reasoning' : /shell|exec_command|powershell/i.test(name) ? 'command' : 'tool_call';
      tail.steps.unshift({ id: !reasoning && callId ? `${taskId}:call:${callId}` : id, kind, label: summary ?? name,
        status: finished ? 'completed' : 'running', startedAt: time, completedAt: finished ? time : undefined });
      if (tail.steps.length > 15) tail.steps.pop();
      tail.status = 'running';
      tail.completedAt = undefined;
    } else return;
  } else return;
  tail.updatedAt = time;
  if (summary && Date.parse(time) >= now - halfHour) {
    events.push({ id, timestamp: time, source, level, taskId, taskTitle: title, summary });
    if (events.length > 80) events.shift();
  }
}

export class CodexAdapter implements CollectorAdapter {
  readonly id = 'codex';
  readonly name = 'Codex';
  readonly intervalMs: number;
  private lastLogId?: number;
  private readonly tails = new Map<string, Rollout>();
  private polling?: Promise<CollectorOutput>;

  constructor(private readonly config: OrreryConfig) {
    this.intervalMs = config.pollIntervalMs;
  }

  private async tailFile(file: string, taskId: string, source: SourceKind, title: string, now: number, follow: boolean) {
    const events: EventEntry[] = [];
    const handle = await open(file, 'r').catch(() => undefined);
    if (!handle) return events;
    try {
      const info = await handle.stat();
      if (!info.isFile()) return events;
      let tail = this.tails.get(file);
      if (!tail || tail.taskId !== taskId || tail.ino !== info.ino || info.size < tail.offset) {
        tail = { taskId, ino: info.ino, offset: 0, lineStart: 0, fragments: [], steps: [], mtimeMs: info.mtimeMs,
          followed: false, samples: [], quotas: [] };
        this.tails.set(file, tail);
      }
      tail.mtimeMs = info.mtimeMs;
      tail.followed ||= follow;
      while (tail.offset < info.size) {
        const length = Math.min(128 * 1024, info.size - tail.offset);
        const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(length), 0, length, tail.offset);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        let start = 0;
        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
          const final = chunk.subarray(start, end);
          const line = tail.fragments.length ? Buffer.concat([...tail.fragments, final]) : final;
          consumeLine(tail, line, taskId, source, title, events, now);
          tail.fragments = [];
          tail.lineStart += line.length + 1;
          start = end + 1;
        }
        if (start < chunk.length) tail.fragments.push(chunk.subarray(start));
        tail.offset += bytesRead;
      }
    } catch (error) {
      // A live rollout may be rotated or temporarily unavailable during a read.
      if (!(error instanceof Error && 'code' in error)) throw error;
    } finally {
      await handle.close();
    }
    return events;
  }

  collect() {
    return this.polling ??= this.collectOnce().finally(() => { this.polling = undefined; });
  }

  private async collectOnce() {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const midnight = new Date(now).setHours(0, 0, 0, 0);
    const result = collectorOutput(this.id, at);
    result.timeline = [];
    result.todayTokens = 0;
    const active = new Map<string, string | undefined>();
    const app = withReadOnlyDb(path.join(this.config.codexDir, 'sqlite', 'codex.db'), db => {
      for (const row of readRows(db, 'SELECT * FROM active_chat_turns')) {
        const id = stringValue(row.thread_id);
        if (id) active.set(id, timestamp(row.observed_at_ms));
      }
      const automations = readFields(db, 'automations', ['id','name','status','next_run_at','last_run_at','cwds','rrule','model']);
      const runs = readFields(db, 'automation_runs', ['automation_id','status','thread_title','created_at','updated_at'])
        .sort((a, b) => (timestamp(b.created_at ?? b.updated_at) ?? '').localeCompare(timestamp(a.created_at ?? a.updated_at) ?? ''));
      const ids = new Set([...automations.map(row => row.id), ...runs.map(run => run.automation_id)]);
      for (const id of ids) {
        const schedule = automations.find(row => row.id === id);
        const history = runs.filter(run => run.automation_id === id);
        const latest = history[0];
        const status = stringValue(schedule?.status)?.toLowerCase();
        const runStatus = taskStatus(latest?.status);
        const cwds = parseJson(schedule?.cwds);
        result.scheduled.push({
          id: `codex:automation:${id}`, source: 'codex', kind: 'automation',
          title: brief(schedule?.name ?? latest?.thread_title) ?? 'Automation',
          status: status === 'paused' || status === 'disabled' ? 'paused'
            : runStatus === 'running' || runStatus === 'queued' || runStatus === 'failed' ? runStatus : 'enabled',
          scheduleText: stringValue(schedule?.rrule), nextRunAt: timestamp(schedule?.next_run_at),
          lastRunAt: timestamp(latest?.created_at ?? latest?.updated_at ?? schedule?.last_run_at),
          lastRunStatus: stringValue(latest?.status), runCount: history.length, model: stringValue(schedule?.model),
          cwd: normalizeWindowsPath(stringValue(Array.isArray(cwds) ? cwds[0] : cwds)),
        });
      }
      return true;
    });

    const state = withReadOnlyDb(path.join(this.config.codexDir, 'state_5.sqlite'), db => {
      const columns = tableColumns(db, 'threads');
      const fields = ['id','rollout_path','created_at_ms','updated_at_ms','created_at','updated_at','source','thread_source',
        'originator','cwd','project_id','title','name','model_provider','model','reasoning_effort','cli_version','git_branch',
        'tokens_used','archived','agent_nickname','agent_role'].filter(key => columns.has(key)).join(', ');
      if (!columns.has('id')) return undefined;
      const updated = columns.has('updated_at_ms') && columns.has('updated_at') ? 'COALESCE(updated_at_ms, updated_at * 1000)'
        : columns.has('updated_at_ms') ? 'updated_at_ms' : columns.has('updated_at') ? 'updated_at * 1000' : '0.0';
      const order = `${updated} DESC, id DESC`;
      const recent = readRows(db, `SELECT ${fields} FROM threads WHERE ${updated} >= ? ORDER BY ${order}`, Math.min(now - dayMs, midnight));
      const open = readRows(db, `SELECT ${fields} FROM threads ${columns.has('archived') ? 'WHERE archived = 0' : ''} ORDER BY ${order} LIMIT 80`);
      const latest = columns.has('rollout_path') && !recent.some(row => stringValue(row.rollout_path)?.endsWith('.jsonl'))
        ? readRows(db, `SELECT id, rollout_path FROM threads WHERE rollout_path LIKE '%.jsonl' ORDER BY ${order} LIMIT 1`)[0] : undefined;
      const byId = new Map([...recent, ...open].map(row => [String(row.id), row]));
      const loadIds = (ids: string[]) => {
        const missing = [...new Set(ids)].filter(id => !byId.has(id));
        if (missing.length) readRows(db, `SELECT ${fields} FROM threads WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(missing))
          .forEach(row => byId.set(String(row.id), row));
      };
      loadIds([...active.keys()]);
      const threads = [...byId.values()];
      const edges = readRows(db, 'SELECT * FROM thread_spawn_edges WHERE parent_thread_id IN (SELECT value FROM json_each(?))',
        JSON.stringify([...byId.keys()]));
      loadIds(edges.map(edge => String(edge.child_thread_id)));
      const projects = new Map(readRows(db, 'SELECT id, name FROM projects').map(row => [row.id, stringValue(row.name)]));
      const roots = readRows(db, 'SELECT project_id, path FROM project_roots').flatMap(row => {
        const root = normalizeWindowsPath(stringValue(row.path));
        return root ? [{ root, project: projects.get(row.project_id) }] : [];
      }).sort((a, b) => b.root.length - a.root.length);
      return { threads, edges, byId, projects, roots, latest };
    });

    const paths = new Set<string>();
    const samples: UsageSample[] = [];
    const tasks = new Map<string, TaskItem>();
    let latestVersion: string | undefined;
    let lastSeen: string | undefined;
    const threads = new Map(state?.threads.map(row => [String(row.id), row]));
    for (const [id, observed] of active) {
      if (!threads.has(id)) threads.set(id, { id, updated_at_ms: Date.parse(observed ?? at) });
    }
    for (const row of threads.values()) {
      const id = String(row.id);
      const taskId = `codex:${id}`;
      const source = sourceOf(row.originator, row.source ?? row.thread_source);
      const title = brief(row.title ?? row.name ?? row.agent_nickname) ?? 'Untitled Codex thread';
      const created = timestamp(row.created_at_ms ?? row.created_at);
      const updated = timestamp(row.updated_at_ms ?? row.updated_at) ?? created;
      const file = normalizeWindowsPath(stringValue(row.rollout_path));
      const activeTurn = active.has(id);
      const threadModel = stringValue(row.model);
      const recent = updated !== undefined && Date.parse(updated) >= now - dayMs;
      let rollout: Rollout | undefined;
      if (file && !file.endsWith('.zst')) {
        paths.add(file);
        const follow = activeTurn || (updated !== undefined && Date.parse(updated) >= now - halfHour);
        if (follow || recent) {
          const events = await this.tailFile(file, taskId, source, title, now, follow);
          if (follow) result.events.push(...events);
        }
        rollout = this.tails.get(file);
        if (rollout?.quotas.length && rollout.quotas[0].checkedAt! > (result.quotas[0]?.checkedAt ?? '')) {
          result.quotas = rollout.quotas;
        }
      }
      const tail = rollout?.followed ? rollout : undefined;
      const start = tail?.startedAt ?? created ?? updated ?? at;
      const update = [updated, tail?.updatedAt, active.get(id)].filter((v): v is string => !!v).sort().at(-1) ?? start;
      const status: TaskStatus = activeTurn ? 'running' : tail?.status === 'running' && (tail.mtimeMs < now - halfHour || row.archived)
        ? 'stale' : tail?.status ?? 'completed';
      const end = status === 'running' ? undefined : tail?.completedAt ?? update;
      const cwd = tail?.cwd ?? normalizeWindowsPath(stringValue(row.cwd));
      const projectPath = (p: string) => /^[A-Za-z]:|^\\\\/.test(p) ? p.toLowerCase().replaceAll('\\', '/').replace(/\/$/, '') : p.replace(/\/$/, '');
      const root = cwd && state?.roots.find(entry => {
        const dir = projectPath(cwd), base = projectPath(entry.root);
        return dir === base || dir.startsWith(base + '/');
      });
      const tokens = tail?.tokens ? { ...tail.tokens } : tokenMetrics(numberValue(row.tokens_used));
      tokens.contextWindow ??= tail?.contextWindow;
      const steps = tail?.steps.map(step => ({ ...step })) ?? [];
      const currentSteps = status === 'running' ? steps.filter(step => step.startedAt >= start) : steps;
      const task: TaskItem = {
        id: taskId, externalIds: { codexThreadId: id, rolloutPath: file }, source, sourceLabel: labels[source], title,
        status, provider: 'codex', model: tail?.model ?? threadModel, reasoningEffort: tail?.effort ?? stringValue(row.reasoning_effort),
        project: state?.projects.get(row.project_id) ?? (root ? root.project : undefined), cwd, gitBranch: stringValue(row.git_branch),
        startedAt: start, updatedAt: update, completedAt: end, durationMs: Math.max(0, Date.parse(end ?? at) - Date.parse(start)),
        currentStep: (currentSteps.find(step => step.status === 'running') ?? currentSteps[0])?.label ?? (status === 'running' ? 'Turn in progress' : undefined),
        recentSteps: steps, tokens,
        subagents: [], pendingInputs: 0, pendingApprovals: 0, hasActionablePlan: false, isStale: status === 'stale',
      };
      tasks.set(id, task);
      const model = rollout?.model ?? threadModel;
      if (recent || activeTurn) {
        if (rollout) {
          rollout.samples = rollout.samples.filter(sample => sample.at >= now - dayMs);
          for (const sample of rollout.samples) {
            const sampledModel = sample.model ?? threadModel ?? rollout.model;
            if (sampledModel) samples.push({ ...sample, model: sampledModel, providerId: this.id, providerName: this.name, sessionId: taskId });
          }
        }
        // Account for a missing or lagging rollout without charging a lifetime total across midnight.
        const unlogged = (numberValue(row.tokens_used) ?? 0) - (rollout?.tokens?.totalTokens ?? 0);
        if (model && unlogged > 0) samples.push({ providerId: this.id, providerName: this.name, model, sessionId: taskId,
          at: Date.parse(update), counterStartedAt: Date.parse(created ?? update),
          input: 0, cached: 0, output: 0, total: unlogged, calls: 0 });
      }
      if (!model && created && Date.parse(created) >= midnight) result.todayTokens += tokens.totalTokens;
      if (status === 'running' || Date.parse(update) >= now - dayMs) result.timeline.push({
        id: `${taskId}:timeline`, taskId, source, provider: task.provider, label: title, project: task.project, status,
        startedAt: start, endedAt: end ?? at, isActive: status === 'running',
      });
      if (!lastSeen || update >= lastSeen) {
        lastSeen = update;
        latestVersion = stringValue(row.cli_version) ?? latestVersion;
      }
    }
    result.modelUsage = summarizeUsage(samples, now).entries.map(entry => ({ ...entry, quotaWindowId: 'primary' }));
    result.todayTokens += result.modelUsage.reduce((sum, entry) => sum + entry.todayTokens, 0);
    // A rollout can exist before the SQLite index or after its thread has been archived.
    if (state?.latest || ![...paths].some(file => this.tails.has(file))) {
      let file = normalizeWindowsPath(stringValue(state?.latest?.rollout_path));
      if (!file || !(await stat(file).catch(() => undefined))?.isFile()) {
        const directory = path.join(this.config.codexDir, 'sessions');
        const files = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
        const candidates = await Promise.all(files.filter(entry => entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)).map(async entry => {
          const file = path.join(entry.parentPath, entry.name);
          const info = await stat(file).catch(() => undefined);
          return { file, mtimeMs: info?.mtimeMs ?? 0 };
        }));
        file = candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file;
      }
      if (file) {
        paths.add(file);
        await this.tailFile(file, `codex:${state?.latest?.id ?? path.basename(file)}`, 'codex-cli', '', now, false);
        const quotas = this.tails.get(file)?.quotas;
        if (quotas?.length && quotas[0].checkedAt! > (result.quotas[0]?.checkedAt ?? '')) result.quotas = quotas;
      }
    }
    if (state) for (const file of this.tails.keys()) if (!paths.has(file)) this.tails.delete(file);
    for (const edge of state?.edges ?? []) {
      const parent = tasks.get(String(edge.parent_thread_id));
      if (!parent) continue;
      const childId = String(edge.child_thread_id);
      const child = tasks.get(childId);
      const row = state?.byId.get(childId);
      const status = active.has(childId) ? 'running' : taskStatus(edge.status, child?.status ?? 'stale');
      const start = child?.startedAt ?? timestamp(row?.created_at_ms ?? row?.created_at) ?? parent.startedAt;
      const end = status === 'running' ? undefined : child?.completedAt ?? timestamp(row?.updated_at_ms ?? row?.updated_at);
      parent.subagents.push({
        id: `codex:subagent:${childId}`, parentId: parent.id, childThreadId: childId, provider: 'codex',
        title: child?.title ?? brief(row?.title ?? row?.agent_nickname) ?? 'Codex subagent',
        model: child?.model ?? stringValue(row?.model), status, currentStep: child?.currentStep,
        startedAt: start, completedAt: end, durationMs: Math.max(0, Date.parse(end ?? at) - Date.parse(start)), origin: 'thread_spawn',
      });
    }
    result.tasks = [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const queued = withReadOnlyDb(path.join(this.config.codexDir, 'queue_1.sqlite'), db => readRows(db, 'SELECT * FROM queued_items ORDER BY queue_order'));
    result.scheduled.push(...(queued ?? []).map((row): ScheduledItem => {
      const data = record(parseJson(row.payload_json));
      const task = tasks.get(String(row.thread_id));
      return { id: `codex:queue:${row.id}`, source: 'codex', kind: 'queued_item', status: 'queued',
        title: brief(data.title ?? data.text ?? record(data.message).text ?? data.message) ?? task?.title ?? 'Queued message', cwd: task?.cwd };
    }));
    const logsDb = withReadOnlyDb(path.join(this.config.codexDir, 'logs_2.sqlite'), db => {
      const latest = readRows(db, 'SELECT max(id) AS id FROM logs')[0];
      if (!latest) return true;
      const head = numberValue(latest.id) ?? 0;
      const initial = this.lastLogId === undefined || this.lastLogId > head;
      const logs = initial
        ? readRows(db, "SELECT * FROM logs WHERE level IN ('WARN','ERROR') AND id <= ? ORDER BY id DESC LIMIT 60", head).reverse()
        : readRows(db, "SELECT * FROM logs WHERE id > ? AND id <= ? AND level IN ('WARN','ERROR') ORDER BY id LIMIT 200", this.lastLogId ?? 0, head);
      for (const row of logs) {
        const id = stringValue(row.thread_id);
        const task = id ? tasks.get(id) : undefined;
        result.events.push({
          id: `codex:log:${row.id}`, source: task?.source ?? 'codex-app', level: row.level === 'ERROR' ? 'error' : 'warn',
          timestamp: timestamp(row.ts) ?? at, taskId: id ? `codex:${id}` : undefined, taskTitle: task?.title,
          summary: brief(record(parseJson(row.feedback_log_body)).message ?? row.feedback_log_body) ?? stringValue(row.target) ?? 'Codex log',
          detail: brief(row.target),
        });
      }
      this.lastLogId = !initial && logs.length === 200 ? numberValue(logs.at(-1)?.id) : head;
      return true;
    });
    result.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const online = state !== null || app || queued !== null || logsDb || active.size > 0 || [...this.tails.values()].some(t => t.mtimeMs >= now - halfHour);
    const agent = agentRuntime(this.id, this.name, online ? 'online' : 'offline', lastSeen ?? at, result.tasks);
    agent.version = latestVersion;
    result.agents.push(agent);
    return result;
  }

  dispose() {
    this.tails.clear();
  }
}
