import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TodoItem, TodoPriority, TodoStatus, TodosPayload } from '@orrery/shared';
import type { OrreryConfig } from '../config.js';

export class TodoValidationError extends Error {}
export class TodoNotFoundError extends Error {}

const MAX_TODOS = 500;
const STATUS_RANK: Record<TodoStatus, number> = { in_progress: 0, blocked: 1, pending: 2, done: 3 };
const PRIORITY_RANK: Record<TodoPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function parseIso(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : undefined;
}

export function normalizeTodoStatus(value: unknown, strict: boolean): TodoStatus {
  if (value === undefined || value === null || value === '') return 'pending';
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'pending':
      case 'todo':
      case 'open':
      case 'queued':
        return 'pending';
      case 'in_progress':
      case 'in-progress':
      case 'running':
      case 'active':
      case 'doing':
      case 'working':
        return 'in_progress';
      case 'blocked':
      case 'waiting':
      case 'error':
      case 'failed':
        return 'blocked';
      case 'done':
      case 'completed':
      case 'complete':
      case 'finished':
        return 'done';
    }
  }
  if (strict) throw new TodoValidationError('Invalid todo status. Expected pending, in_progress, blocked, or done.');
  return 'pending';
}

export function normalizeTodoPriority(value: unknown, strict: boolean): TodoPriority {
  if (value === undefined || value === null || value === '') return 'normal';
  if (typeof value === 'string') {
    switch (value.trim().toLowerCase()) {
      case 'critical':
      case 'urgent':
      case 'p0':
        return 'critical';
      case 'high':
      case 'p1':
        return 'high';
      case 'normal':
      case 'medium':
      case 'p2':
        return 'normal';
      case 'low':
      case 'p3':
        return 'low';
    }
  }
  if (strict) throw new TodoValidationError('Invalid todo priority. Expected low, normal, high, or critical.');
  return 'normal';
}

export function sortTodos(items: TodoItem[]): TodoItem[] {
  return [...items].sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
    a.id.localeCompare(b.id));
}

function stableFallbackId(title: string, index: number): string {
  return 'todo-' + createHash('sha1').update(`${index}:${title}`).digest('hex').slice(0, 12);
}

function parseItem(raw: unknown, strict: boolean, nowIso: string, index = 0): TodoItem | undefined {
  if (!record(raw)) {
    if (strict) throw new TodoValidationError('Expected a todo object.');
    return undefined;
  }
  const title = cleanText(raw.title ?? raw.content ?? raw.text, 500);
  if (!title) {
    if (strict) throw new TodoValidationError('Todo title is required.');
    return undefined;
  }
  const id = cleanText(raw.id, 160) ?? (strict ? randomUUID() : stableFallbackId(title, index));
  const status = normalizeTodoStatus(raw.status, strict);
  const priority = normalizeTodoPriority(raw.priority, strict);
  const createdAt = parseIso(raw.createdAt) ?? nowIso;
  const updatedAt = parseIso(raw.updatedAt) ?? createdAt;
  const completedAt = status === 'done' ? (parseIso(raw.completedAt) ?? updatedAt) : undefined;
  const agent = cleanText(raw.agent ?? raw.source, 120);
  const project = cleanText(raw.project, 120);
  const cwd = cleanText(raw.cwd, 520);
  const note = cleanText(raw.note ?? raw.detail ?? raw.description, 2000);

  return {
    id,
    title,
    status,
    priority,
    ...(agent ? { agent } : {}),
    ...(project ? { project } : {}),
    ...(cwd ? { cwd } : {}),
    ...(note ? { note } : {}),
    createdAt,
    updatedAt,
    ...(completedAt ? { completedAt } : {}),
  };
}

function extractRawList(value: unknown, strict: boolean): unknown[] {
  if (Array.isArray(value)) return value;
  if (record(value)) {
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.todos)) return value.todos;
  }
  if (strict) throw new TodoValidationError('Expected an items array or a todo array.');
  return [];
}

function parseTodoList(value: unknown, strict: boolean, nowIso = new Date().toISOString()): TodoItem[] {
  const list = extractRawList(value, strict);
  if (strict && list.length > MAX_TODOS) {
    throw new TodoValidationError(`Too many todo items (max ${MAX_TODOS}).`);
  }
  const byId = new Map<string, TodoItem>();
  list.slice(0, MAX_TODOS).forEach((entry, index) => {
    const parsed = parseItem(entry, strict, nowIso, index);
    if (parsed) byId.set(parsed.id, parsed);
  });
  return sortTodos([...byId.values()]);
}

function applyPatchFields(existing: TodoItem, raw: Record<string, unknown>, nowIso: string): TodoItem {
  let title = existing.title;
  const titleCandidate = raw.title ?? raw.content ?? raw.text;
  if (titleCandidate !== undefined) {
    const nextTitle = cleanText(titleCandidate, 500);
    if (!nextTitle) throw new TodoValidationError('Todo title cannot be empty.');
    title = nextTitle;
  }
  const status = raw.status !== undefined ? normalizeTodoStatus(raw.status, true) : existing.status;
  const priority = raw.priority !== undefined ? normalizeTodoPriority(raw.priority, true) : existing.priority;

  const pickOptional = (keys: string[], current: string | undefined, max: number) => {
    const touched = keys.find(key => Object.hasOwn(raw, key));
    if (!touched) return current;
    const val = raw[touched];
    if (val === null || val === '') return undefined;
    if (typeof val !== 'string') throw new TodoValidationError(`Invalid ${touched} field.`);
    return cleanText(val, max);
  };

  const agent = pickOptional(['agent', 'source'], existing.agent, 120);
  const project = pickOptional(['project'], existing.project, 120);
  const cwd = pickOptional(['cwd'], existing.cwd, 520);
  const note = pickOptional(['note', 'detail', 'description'], existing.note, 2000);
  const completedAt = status === 'done'
    ? (existing.status === 'done' ? existing.completedAt ?? nowIso : nowIso)
    : undefined;

  return {
    id: existing.id,
    title,
    status,
    priority,
    ...(agent ? { agent } : {}),
    ...(project ? { project } : {}),
    ...(cwd ? { cwd } : {}),
    ...(note ? { note } : {}),
    createdAt: existing.createdAt,
    updatedAt: nowIso,
    ...(completedAt ? { completedAt } : {}),
  };
}

export class TodoStore {
  readonly filePath: string;
  private pendingWrite = Promise.resolve();
  private cachedKey = '';
  private cachedItems: TodoItem[] = [];
  private cachedUpdatedAt = new Date(0).toISOString();
  private onChange?: (items: TodoItem[]) => void;

  constructor(config: Pick<OrreryConfig, 'todosFilePath'> | string, onChange?: (items: TodoItem[]) => void) {
    this.filePath = typeof config === 'string' ? config : config.todosFilePath;
    this.onChange = onChange;
  }

  setOnChange(listener?: (items: TodoItem[]) => void) {
    this.onChange = listener;
  }

  async list(): Promise<TodoItem[]> {
    await this.pendingWrite;
    try {
      const info = await stat(this.filePath);
      const key = `${info.mtimeMs}:${info.size}`;
      if (key === this.cachedKey) return this.cachedItems;
      const rawText = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(rawText);
      const fallbackNow = new Date(info.mtimeMs || Date.now()).toISOString();
      const items = parseTodoList(parsed, false, fallbackNow);
      const updatedAt = record(parsed) ? (parseIso(parsed.updatedAt) ?? fallbackNow) : fallbackNow;
      this.cachedKey = key;
      this.cachedItems = items;
      this.cachedUpdatedAt = updatedAt;
      return items;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cachedKey = 'missing';
        this.cachedItems = [];
        return [];
      }
      if (error instanceof SyntaxError) {
        return this.cachedItems;
      }
      throw error;
    }
  }

  async payload(): Promise<TodosPayload & { filePath: string }> {
    const items = await this.list();
    return { updatedAt: this.cachedUpdatedAt, items, filePath: this.filePath };
  }

  private async commit(mutate: (current: TodoItem[], nowIso: string) => TodoItem[]): Promise<TodoItem[]> {
    let result: TodoItem[] = [];
    const write = this.pendingWrite.then(async () => {
      let current = this.cachedItems;
      try {
        const rawText = await readFile(this.filePath, 'utf8');
        current = parseTodoList(JSON.parse(rawText), false);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = [];
        else if (!(error instanceof SyntaxError)) throw error;
      }
      const nowIso = new Date().toISOString();
      const next = sortTodos(mutate(current, nowIso)).slice(0, MAX_TODOS);
      const body: TodosPayload = { updatedAt: nowIso, items: next };
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = this.filePath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify(body, null, 2) + '\n', 'utf8');
        await rename(temp, this.filePath);
      } finally {
        await rm(temp, { force: true });
      }
      const info = await stat(this.filePath).catch(() => undefined);
      this.cachedKey = info ? `${info.mtimeMs}:${info.size}` : '';
      this.cachedItems = next;
      this.cachedUpdatedAt = nowIso;
      result = next;
    });
    this.pendingWrite = write.catch(() => {});
    await write;
    this.onChange?.(result);
    return result;
  }

  async upsert(input: unknown): Promise<{ created: boolean; item: TodoItem; items: TodoItem[] }> {
    if (!record(input)) throw new TodoValidationError('Expected a JSON object for todo item.');
    const requestedId = cleanText(input.id, 160);
    let created = false;
    let savedItem!: TodoItem;
    const items = await this.commit((current, nowIso) => {
      const idx = requestedId ? current.findIndex(item => item.id === requestedId) : -1;
      if (idx >= 0) {
        created = false;
        savedItem = applyPatchFields(current[idx], input, nowIso);
        const copy = [...current];
        copy[idx] = savedItem;
        return copy;
      }
      if (current.length >= MAX_TODOS) {
        throw new TodoValidationError(`Todo limit reached (max ${MAX_TODOS}). Clear completed items first.`);
      }
      created = true;
      savedItem = parseItem({ ...input, id: requestedId ?? randomUUID(), createdAt: nowIso, updatedAt: nowIso }, true, nowIso)!;
      return [...current, savedItem];
    });
    return { created, item: savedItem, items };
  }

  async patch(id: string, input: unknown): Promise<{ item: TodoItem; items: TodoItem[] }> {
    const targetId = cleanText(id, 160);
    if (!targetId) throw new TodoNotFoundError('Todo item not found.');
    if (!record(input)) throw new TodoValidationError('Expected a JSON object for todo update.');
    let savedItem!: TodoItem;
    const items = await this.commit((current, nowIso) => {
      const idx = current.findIndex(item => item.id === targetId);
      if (idx < 0) throw new TodoNotFoundError('Todo item not found.');
      savedItem = applyPatchFields(current[idx], input, nowIso);
      const copy = [...current];
      copy[idx] = savedItem;
      return copy;
    });
    return { item: savedItem, items };
  }

  async replaceAll(input: unknown, merge = false): Promise<TodoItem[]> {
    const incomingRaw = extractRawList(input, true);
    if (incomingRaw.length > MAX_TODOS) {
      throw new TodoValidationError(`Too many todo items (max ${MAX_TODOS}).`);
    }
    return this.commit((current, nowIso) => {
      const existingById = new Map(current.map(item => [item.id, item]));
      const nextById = merge ? new Map(existingById) : new Map<string, TodoItem>();
      incomingRaw.forEach((raw, index) => {
        if (!record(raw)) throw new TodoValidationError('Expected each todo entry to be an object.');
        const rawId = cleanText(raw.id, 160);
        const prev = rawId ? existingById.get(rawId) : undefined;
        const item = prev
          ? applyPatchFields(prev, raw, nowIso)
          : parseItem({ ...raw, id: rawId ?? randomUUID(), createdAt: parseIso(raw.createdAt) ?? nowIso, updatedAt: nowIso }, true, nowIso, index)!;
        nextById.set(item.id, item);
      });
      return [...nextById.values()];
    });
  }

  async remove(id: string): Promise<{ removed: boolean; items: TodoItem[] }> {
    const targetId = cleanText(id, 160);
    if (!targetId) throw new TodoNotFoundError('Todo item not found.');
    let removed = false;
    const items = await this.commit(current => {
      const filtered = current.filter(item => item.id !== targetId);
      if (filtered.length === current.length) throw new TodoNotFoundError('Todo item not found.');
      removed = true;
      return filtered;
    });
    return { removed, items };
  }

  async clear(all = false): Promise<{ removed: number; items: TodoItem[] }> {
    let removed = 0;
    const items = await this.commit(current => {
      const kept = all ? [] : current.filter(item => item.status !== 'done');
      removed = current.length - kept.length;
      return kept;
    });
    return { removed, items };
  }
}
