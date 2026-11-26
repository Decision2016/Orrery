import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProcessMetric, TaskItem } from '@orrery/shared';
import type { OrreryConfig } from '../config.js';
import { CodexAdapter } from './codex.js';
import { ProcessAdapter } from './process.js';
import {
  agentRuntime, brief, collectorOutput, normalizeWindowsPath, numberValue, parseJson, readJsonFile,
  readRows, record, stringValue, timestamp, withReadOnlyDb,
} from './sqlite.js';
import { T3Adapter } from './t3.js';
import type { CollectorAdapter } from './types.js';

export { T3Adapter, CodexAdapter, ProcessAdapter };

type Session = { id: string; title?: string; cwd?: string; start?: string; updated: string; pid?: number; model?: string };
type ProcessReader = () => Promise<ProcessMetric[]>;

async function sampleLines(file: string, bytes: number, fromEnd: boolean) {
  const handle = await open(file, 'r').catch(() => undefined);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const length = Math.min(bytes, size);
    const start = fromEnd ? size - length : 0;
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(length), 0, length, start);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    if (start) lines.shift();
    return lines.filter(Boolean).map(line => record(parseJson(line)));
  } catch {
    return [];
  } finally {
    await handle.close();
  }
}

abstract class SessionDetector implements CollectorAdapter {
  abstract readonly id: 'claude-code' | 'opencode';
  abstract readonly name: string;
  readonly intervalMs: number;

  constructor(private readonly config: OrreryConfig, private readonly dirs: string[], private readonly processes: ProcessReader) {
    this.intervalMs = Math.max(30_000, config.processPollIntervalMs);
  }

  protected abstract sessions(dir: string, since: number): Promise<Session[]>;

  async collect() {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const since = now - this.config.recentWindowHours * 3_600_000;
    const [processes, directories] = await Promise.all([
      this.processes(), Promise.all(this.dirs.map(async dir => (await stat(dir).catch(() => undefined))?.isDirectory() ? dir : undefined)),
    ]);
    const live = processes.filter(proc => proc.agentId === this.id);
    const sessions = (await Promise.all(directories.flatMap(dir => dir ? [this.sessions(dir, since)] : []))).flat()
      .filter(session => Date.parse(session.updated) >= since || live.some(proc => proc.pid === session.pid))
      .sort((a, b) => b.updated.localeCompare(a.updated));
    const unique = new Map<string, Session>();
    for (const session of sessions) {
      const latest = unique.get(session.id);
      if (latest) {
        latest.pid ??= session.pid;
        latest.start ??= session.start;
        latest.title ??= session.title;
        latest.cwd ??= session.cwd;
        latest.model ??= session.model;
      } else unique.set(session.id, session);
    }
    const result = collectorOutput(this.id, at);
    result.tasks = [...unique.values()].slice(0, 30).map((session): TaskItem => {
      const active = !!session.pid && live.some(proc => proc.pid === session.pid);
      const start = session.start ?? session.updated;
      const cwd = normalizeWindowsPath(session.cwd);
      return {
        id: `${this.id}:${session.id}`, externalIds: {}, source: this.id, sourceLabel: this.name,
        title: session.title ?? `${this.name} session`, provider: this.id, model: session.model, cwd,
        project: cwd && path.win32.basename(cwd), status: active ? 'running' : 'completed', startedAt: start,
        updatedAt: session.updated, completedAt: active ? undefined : session.updated,
        durationMs: Math.max(0, (active ? now : Date.parse(session.updated)) - Date.parse(start)),
        recentSteps: [], subagents: [], pendingInputs: 0, pendingApprovals: 0, hasActionablePlan: false,
      };
    });
    const lastSeen = sessions[0]?.updated;
    const online = live.length > 0 || (lastSeen && Date.parse(lastSeen) >= now - this.config.staleThresholdMs);
    const agent = agentRuntime(this.id, this.name, online ? 'online' : 'offline', live.length ? at : lastSeen ?? at, result.tasks);
    agent.detail = directories.find(Boolean);
    agent.pids = live.map(proc => proc.pid);
    agent.processCount = live.length;
    agent.cpuPercent = live.reduce((sum, p) => sum + p.cpuPercent, 0);
    agent.memoryMb = live.reduce((sum, p) => sum + p.memoryMb, 0);
    result.agents.push(agent);
    return result;
  }
}

export class ClaudeCodeDetectorAdapter extends SessionDetector {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  constructor(config: OrreryConfig, dir = path.join(os.homedir(), '.claude'), processes: ProcessReader = async () => []) {
    super(config, [dir], processes);
  }

  protected async sessions(dir: string, since: number) {
    const history = await sampleLines(path.join(dir, 'history.jsonl'), 128 * 1024, true);
    const sessions: Session[] = history.flatMap(row => {
      const id = stringValue(row.sessionId), updated = timestamp(row.timestamp);
      return id && updated && Date.parse(updated) >= since
        ? [{ id, title: brief(row.display), cwd: stringValue(row.project), updated }] : [];
    });
    const files = await readdir(path.join(dir, 'sessions')).catch(() => []);
    for (const file of files.filter(name => name.endsWith('.json'))) {
      const data = record(await readJsonFile(path.join(dir, 'sessions', file)));
      const id = stringValue(data.sessionId ?? data.id), start = timestamp(data.startedAt);
      const updated = timestamp(data.updatedAt) ?? start;
      if (id && updated) sessions.push({ id, title: brief(data.title), cwd: stringValue(data.cwd),
        start, updated, pid: numberValue(data.pid), model: stringValue(data.model) });
    }
    // SDK sessions can have a project transcript without an interactive history entry.
    const projects = path.join(dir, 'projects');
    const folders = await readdir(projects, { withFileTypes: true }).catch(() => []);
    const groups = await Promise.all(folders.filter(entry => entry.isDirectory()).map(async entry => {
      const folder = path.join(projects, entry.name);
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      return Promise.all(entries.filter(file => file.isFile() && file.name.endsWith('.jsonl')).map(async file => {
        const full = path.join(folder, file.name);
        const info = await stat(full).catch(() => undefined);
        return { file: full, id: path.basename(file.name, '.jsonl'), mtime: info?.mtimeMs ?? 0 };
      }));
    }));
    const known = new Set(sessions.map(session => session.id));
    const recent = groups.flat().filter(file => file.mtime >= since && !known.has(file.id))
      .sort((a, b) => b.mtime - a.mtime).slice(0, 30);
    const transcripts = await Promise.all(recent.map(async file => {
      const lines = await sampleLines(file.file, 32 * 1024, false);
      const first = lines.find(row => row.cwd);
      const message = record(lines.find(row => row.type === 'user')?.message);
      return { id: file.id, cwd: stringValue(first?.cwd), start: timestamp(first?.timestamp),
        updated: new Date(file.mtime).toISOString(), title: brief(message.content) };
    }));
    return [...sessions, ...transcripts];
  }
}

export class OpenCodeDetectorAdapter extends SessionDetector {
  readonly id = 'opencode';
  readonly name = 'OpenCode';

  constructor(config: OrreryConfig, dir?: string, processes: ProcessReader = async () => []) {
    super(config, dir ? [dir] : [path.join(os.homedir(), '.opencode'),
      path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'opencode')], processes);
  }

  protected async sessions(dir: string, since: number) {
    const sqlite = withReadOnlyDb(path.join(dir, 'opencode.db'), db =>
      readRows(db, 'SELECT * FROM session WHERE time_updated >= ? ORDER BY time_updated DESC LIMIT 30', since)) ?? [];
    const sessions: Session[] = sqlite.flatMap(row => {
      const id = stringValue(row.id), updated = timestamp(row.time_updated);
      return id && updated ? [{ id, updated, start: timestamp(row.time_created), cwd: stringValue(row.directory), title: brief(row.title) }] : [];
    });
    const base = path.join(dir, 'storage', 'session');
    const roots = await readdir(base, { withFileTypes: true }).catch(() => []);
    const nested = await Promise.all(roots.filter(entry => entry.isDirectory()).map(async entry => {
      const children = await readdir(path.join(base, entry.name), { withFileTypes: true }).catch(() => []);
      return children.filter(child => child.isFile()).map(child => path.join(base, entry.name, child.name));
    }));
    const paths = [...roots.filter(entry => entry.isFile()).map(entry => path.join(base, entry.name)), ...nested.flat()]
      .filter(file => file.endsWith('.json'));
    const files = await Promise.all(paths.map(async file => ({ file, info: await stat(file).catch(() => undefined) })));
    for (const { file } of files.filter(entry => entry.info && entry.info.mtimeMs >= since)
      .sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs).slice(0, 30)) {
      const data = record(await readJsonFile(file)), time = record(data.time);
      const id = stringValue(data.id), updated = timestamp(time.updated ?? time.created);
      if (id && updated) sessions.push({ id, updated, start: timestamp(time.created), cwd: stringValue(data.directory), title: brief(data.title) });
    }
    return sessions;
  }
}

export function createDefaultAdapters(config: OrreryConfig): CollectorAdapter[] {
  const processes = new ProcessAdapter(config);
  const sample = () => processes.sampleProcesses();
  return [new T3Adapter(config), new CodexAdapter(config), processes,
    new ClaudeCodeDetectorAdapter(config, undefined, sample), new OpenCodeDetectorAdapter(config, undefined, sample)];
}
