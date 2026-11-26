import { readFile } from 'node:fs/promises';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { AgentRuntime, TaskItem, TaskStatus, TokenMetrics } from '@orrery/shared';
import type { CollectorOutput } from './types.js';

export function withReadOnlyDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 1500; PRAGMA query_only = ON;');
    } catch {
      // Some read-only database builds reject PRAGMAs. The open flag still applies.
    }
    return fn(db);
  } catch (error) {
    if (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_SQLITE')) {
      return null;
    }
    throw error;
  } finally {
    db?.close();
  }
}

export function normalizeWindowsPath(p?: string | null): string | undefined {
  return p?.trim().replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '') || undefined;
}

export function readRows(db: DatabaseSync, sql: string, ...params: SQLInputValue[]) {
  try {
    return db.prepare(sql).all(...params);
  } catch (error) {
    // An optional projection may be absent in a different schema version.
    if (error instanceof Error && /no such (?:table|column)|has no column named/i.test(error.message)) return [];
    throw error;
  }
}

export function tableColumns(db: DatabaseSync, table: string) {
  return new Set(readRows(db, 'SELECT name FROM pragma_table_info(?)', table).map(row => String(row.name)));
}

export function readFields(db: DatabaseSync, table: string, fields: string[]) {
  const columns = tableColumns(db, table);
  const select = fields.filter(field => columns.has(field)).join(', ');
  return select ? readRows(db, `SELECT ${select} FROM ${table}`) : [];
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function numberValue(value: unknown) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export function timestamp(value: unknown): string | undefined {
  const n = numberValue(value);
  const ms = n === undefined ? Date.parse(stringValue(value) ?? '') : Math.abs(n) < 1e11 ? n * 1000 : n;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function brief(value: unknown, limit = 180) {
  return stringValue(value)?.replace(/\s+/g, ' ').slice(0, limit);
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function readJsonFile(file: string) {
  return readFile(file, 'utf8').then(parseJson, () => undefined);
}

export function collectorOutput(adapterId: string, collectedAt: string): CollectorOutput {
  return { adapterId, collectedAt, ok: true, agents: [], quotas: [], tasks: [], alerts: [], scheduled: [], events: [] };
}

export function tokenMetrics(totalTokens = 0): TokenMetrics {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens };
}

export function taskStatus(raw: unknown, fallback: TaskStatus = 'stale'): TaskStatus {
  switch (stringValue(raw)?.toLowerCase()) {
    case 'active': case 'running': case 'in_progress': case 'starting': case 'preparing': return 'running';
    case 'queued': case 'pending': return 'queued';
    case 'waiting_approval': case 'pending_approval': return 'waiting_approval';
    case 'waiting': case 'waiting_input': case 'user_input': return 'waiting_input';
    case 'failed': case 'error': return 'failed';
    case 'interrupted': case 'aborted': case 'rolled_back': return 'interrupted';
    case 'cancelled': case 'canceled': return 'cancelled';
    case 'idle': case 'closed': case 'completed': case 'succeeded': case 'done': return 'completed';
    default: return fallback;
  }
}

export function agentRuntime(id: string, name: string, status: AgentRuntime['status'], lastSeenAt: string, tasks: TaskItem[]): AgentRuntime {
  return {
    id, name, status, lastSeenAt,
    runningCount: tasks.filter(task => task.status === 'running').length,
    waitingCount: tasks.filter(task => task.status.startsWith('waiting')).length,
    queuedCount: tasks.filter(task => task.status === 'queued').length,
    subagentCount: tasks.reduce((n, task) => n + task.subagents.filter(sub =>
      sub.status === 'running' || sub.status === 'queued' || sub.status.startsWith('waiting')).length, 0),
    cpuPercent: 0, memoryMb: 0, processCount: 0, pids: [],
  };
}
