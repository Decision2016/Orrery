import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CORE_TOKEN_PROVIDERS,
  type DailyProviderTokens,
  type DailyTokenPoint,
  type ModelUsageEntry,
  type TokenActivityPayload,
  type TokenProviderMeta,
} from '@orrery/shared';
import {
  normalizeWindowsPath,
  numberValue,
  parseJson,
  readJsonFile,
  readRows,
  record,
  stringValue,
  tableColumns,
  timestamp,
  withReadOnlyDb,
} from '../adapters/sqlite.js';
import type { OrreryConfig } from '../config.js';

const RETENTION_DAYS = 380;
const DAY_MS = 86_400_000;

export const TOKEN_PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  gemini: 'Gemini',
  claude: 'Claude',
  deepseek: 'DeepSeek',
  grok: 'Grok',
  opencode: 'OpenCode',
  pi: 'Pi',
  other: 'Other',
};

type CompactTuple = [input: number, cached: number, output: number, total: number, calls: number];
type FileDayMap = Record<string, Record<string, CompactTuple>>;

interface CachedFileEntry {
  m: number;
  s: number;
  o: 'orrery' | 'provider';
  d: FileDayMap;
}

interface CachedAgTranscript {
  m: number;
  s: number;
  steps: [stepIndex: number, date: string, provider: string, input: number, cached: number, output: number][];
}

interface PersistedLedger {
  version: 1;
  updatedAt: string;
  lastSyncedAt?: string;
  v17Rev?: string;
  liveFloor: FileDayMap;
  files: Record<string, CachedFileEntry>;
  agFiles: Record<string, CachedAgTranscript>;
  fallbackDays: FileDayMap;
}

export function toLocalDateKey(ms: number): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function classifyTokenProvider(model?: string, rawProvider?: string): string {
  const m = (model ?? '').trim().toLowerCase();
  const p = (rawProvider ?? '').trim().toLowerCase();
  if (m.includes('deepseek') || p === 'deepseek') return 'deepseek';
  if (m.startsWith('gemini') || m.includes('/gemini') || p === 'gemini') return 'gemini';
  if (m.startsWith('claude') || m.includes('/claude') || m.includes('anthropic')) return 'claude';
  if (/^(gpt-|o1|o3|o4|codex|chatgpt|text-embedding|computer-use)/i.test(m) || m.includes('openai')) return 'openai';
  if (m.startsWith('grok') || p === 'grok') return 'grok';
  if (p === 'codex' || p === 'openai') return 'openai';
  if (p === 'antigravity') return 'gemini';
  if (p === 'claude' || p === 'claudeagent' || p === 'claude-code' || p === 'anthropic') return 'claude';
  if (p === 'opencode') return 'opencode';
  if (p === 'pi') return 'pi';
  return p || 'other';
}

function canonicalKey(filePath: string): string {
  const normalized = normalizeWindowsPath(filePath) ?? filePath;
  return process.platform === 'win32'
    ? path.win32.normalize(normalized).toLowerCase()
    : path.posix.normalize(normalized);
}

function addTuple(map: FileDayMap, date: string, provider: string, input: number, cached: number, output: number, total: number, calls: number) {
  if (total <= 0 && input <= 0 && cached <= 0 && output <= 0) return;
  const byProv = (map[date] ??= {});
  const cur = (byProv[provider] ??= [0, 0, 0, 0, 0]);
  cur[0] += Math.max(0, Math.round(input));
  cur[1] += Math.max(0, Math.round(cached));
  cur[2] += Math.max(0, Math.round(output));
  cur[3] += Math.max(0, Math.round(total));
  cur[4] += Math.max(0, Math.round(calls));
}

function cutoffDateKey(nowMs: number): string {
  return toLocalDateKey(nowMs - RETENTION_DAYS * DAY_MS);
}

function pruneDayMap(map: FileDayMap, minDate: string): FileDayMap {
  const next: FileDayMap = {};
  for (const [date, byProv] of Object.entries(map)) {
    if (date >= minDate) next[date] = byProv;
  }
  return next;
}

function yieldEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

async function parseCodexRolloutDays(file: string, fallbackMtime: number, minDate: string): Promise<FileDayMap> {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text) return {};
  const days: FileDayMap = {};
  let model: string | undefined;
  let prevTotal = 0;
  let prevInput = 0;
  let prevCached = 0;
  let prevOutput = 0;

  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.includes('"turn_context"')) {
      const env = record(parseJson(line));
      if (env.type === 'turn_context') {
        model = stringValue(record(env.payload).model) ?? model;
      }
      continue;
    }
    if (!line.includes('"token_count"')) continue;
    const env = record(parseJson(line));
    if (env.type !== 'event_msg') continue;
    const payload = record(env.payload);
    if (payload.type !== 'token_count') continue;
    const totalObj = record(record(payload.info).total_token_usage);
    const totalTokens = numberValue(totalObj.total_tokens);
    const inputTokens = numberValue(totalObj.input_tokens) ?? 0;
    const cachedTokens = numberValue(totalObj.cached_input_tokens) ?? 0;
    const outputTokens = numberValue(totalObj.output_tokens) ?? 0;
    const effectiveTotal = totalTokens ?? (inputTokens + outputTokens);
    if (effectiveTotal <= 0) continue;

    if (effectiveTotal < prevTotal) {
      prevTotal = 0;
      prevInput = 0;
      prevCached = 0;
      prevOutput = 0;
    }
    const deltaTotal = effectiveTotal - prevTotal;
    if (deltaTotal > 0) {
      const deltaCached = Math.max(0, cachedTokens - prevCached);
      const deltaInput = Math.max(0, inputTokens - prevInput - deltaCached);
      const deltaOutput = Math.max(0, outputTokens - prevOutput);
      const ts = timestamp(env.timestamp);
      const date = toLocalDateKey(ts ? Date.parse(ts) : fallbackMtime);
      if (date >= minDate) {
        addTuple(days, date, classifyTokenProvider(model, 'openai'), deltaInput, deltaCached, deltaOutput, deltaTotal, 1);
      }
    }
    prevTotal = effectiveTotal;
    prevInput = inputTokens;
    prevCached = cachedTokens;
    prevOutput = outputTokens;
  }
  return days;
}

async function parseClaudeTranscriptDays(file: string, fallbackMtime: number, minDate: string): Promise<FileDayMap> {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text) return {};
  const byMsg = new Map<string, { date: string; provider: string; input: number; cached: number; output: number; total: number }>();

  let idx = 0;
  for (const line of text.split('\n')) {
    idx++;
    if (!line.includes('"usage"')) continue;
    const row = record(parseJson(line));
    const msg = record(row.message);
    const usage = record(msg.usage ?? row.usage);
    if (!Object.keys(usage).length) continue;
    const uncached = (numberValue(usage.input_tokens) ?? 0) + (numberValue(usage.cache_creation_input_tokens) ?? 0);
    const cached = numberValue(usage.cache_read_input_tokens) ?? 0;
    const output = numberValue(usage.output_tokens) ?? 0;
    const total = uncached + cached + output;
    if (total <= 0) continue;
    const ts = timestamp(row.timestamp ?? msg.created_at);
    const date = toLocalDateKey(ts ? Date.parse(ts) : fallbackMtime);
    if (date < minDate) continue;
    const provider = classifyTokenProvider(stringValue(msg.model ?? row.model), 'claude');
    const key = stringValue(msg.id) ?? stringValue(row.uuid) ?? `line:${idx}`;
    const prev = byMsg.get(key);
    if (!prev || total >= prev.total) {
      byMsg.set(key, { date, provider, input: uncached, cached, output, total });
    }
  }

  const days: FileDayMap = {};
  for (const item of byMsg.values()) {
    addTuple(days, item.date, item.provider, item.input, item.cached, item.output, item.total, 1);
  }
  return days;
}

async function parseAntigravitySteps(
  file: string,
  fallbackMtime: number,
  minDate: string,
): Promise<CachedAgTranscript['steps']> {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text) return [];
  const steps: CachedAgTranscript['steps'] = [];
  let idx = 0;
  for (const line of text.split('\n')) {
    idx++;
    if (!line.includes('"PLANNER_RESPONSE"')) continue;
    const step = record(parseJson(line));
    const model = stringValue(step.model);
    if (step.type !== 'PLANNER_RESPONSE' || !model) continue;
    const ts = timestamp(step.created_at);
    const date = toLocalDateKey(ts ? Date.parse(ts) : fallbackMtime);
    if (date < minDate) continue;
    const input = numberValue(step.input_tokens) ?? 0;
    const cached = numberValue(step.cache_read_tokens) ?? 0;
    const output = numberValue(step.output_tokens) ?? 0;
    if (input + cached + output <= 0) continue;
    steps.push([
      numberValue(step.step_index) ?? idx,
      date,
      classifyTokenProvider(model, 'gemini'),
      input,
      cached,
      output,
    ]);
  }
  return steps;
}

export function emptyTokenActivity(updatedAt = new Date().toISOString()): TokenActivityPayload {
  return {
    updatedAt,
    days: [],
    providers: CORE_TOKEN_PROVIDERS.map(p => ({ ...p, totalTokens: 0, todayTokens: 0, activeDays: 0 })),
  };
}

export class TokenActivityStore {
  readonly filePath: string;
  private ledger: PersistedLedger = {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    liveFloor: {},
    files: {},
    agFiles: {},
    fallbackDays: {},
  };
  private loaded = false;
  private syncingPromise?: Promise<TokenActivityPayload>;
  private pendingWrite = Promise.resolve();
  private lastLiveSaveMs = 0;
  private payloadCache?: TokenActivityPayload;
  private onChange?: (payload: TokenActivityPayload) => void;

  constructor(private readonly config: OrreryConfig, onChange?: (payload: TokenActivityPayload) => void) {
    this.filePath = config.tokenActivityFilePath;
    this.onChange = onChange;
  }

  setOnChange(listener?: (payload: TokenActivityPayload) => void) {
    this.onChange = listener;
  }

  async load(): Promise<TokenActivityPayload> {
    if (!this.loaded) {
      try {
        const raw = record(JSON.parse(await readFile(this.filePath, 'utf8')));
        if (raw.version === 1) {
          this.ledger = {
            version: 1,
            updatedAt: stringValue(raw.updatedAt) ?? new Date().toISOString(),
            lastSyncedAt: stringValue(raw.lastSyncedAt),
            v17Rev: stringValue(raw.v17Rev),
            liveFloor: (record(raw.liveFloor) as FileDayMap) ?? {},
            files: (record(raw.files) as Record<string, CachedFileEntry>) ?? {},
            agFiles: (record(raw.agFiles) as Record<string, CachedAgTranscript>) ?? {},
            fallbackDays: (record(raw.fallbackDays) as FileDayMap) ?? {},
          };
        }
      } catch {
        // Start with fresh ledger when cache file does not exist or is unreadable.
      }
      this.loaded = true;
    }
    this.payloadCache ??= this.buildPayload();
    return this.payloadCache;
  }

  getPayload(): TokenActivityPayload {
    return this.payloadCache ?? this.buildPayload();
  }

  recordLiveUsage(entries: ModelUsageEntry[], nowMs = Date.now()) {
    if (!entries.length) return;
    const today = toLocalDateKey(nowMs);
    const sums = new Map<string, CompactTuple>();
    for (const entry of entries) {
      if (entry.todayTokens <= 0) continue;
      const provider = classifyTokenProvider(entry.model, entry.providerId);
      const cur = sums.get(provider) ?? [0, 0, 0, 0, 0];
      const ratio = entry.tokens24h > 0 ? Math.min(1, entry.todayTokens / entry.tokens24h) : 0;
      cur[0] += Math.round(entry.inputTokens24h * ratio);
      cur[1] += Math.round(entry.cachedTokens24h * ratio);
      cur[2] += Math.round(entry.outputTokens24h * ratio);
      cur[3] += Math.round(entry.todayTokens);
      cur[4] += Math.max(1, Math.round(entry.calls24h * ratio));
      sums.set(provider, cur);
    }
    if (!sums.size) return;

    const todayFloor = (this.ledger.liveFloor[today] ??= {});
    let changed = false;
    for (const [provider, next] of sums) {
      const prev = todayFloor[provider];
      if (!prev || next[3] > prev[3]) {
        todayFloor[provider] = prev
          ? [Math.max(prev[0], next[0]), Math.max(prev[1], next[1]), Math.max(prev[2], next[2]), Math.max(prev[3], next[3]), Math.max(prev[4], next[4])]
          : next;
        changed = true;
      }
    }
    if (changed) {
      this.ledger.updatedAt = new Date(nowMs).toISOString();
      this.payloadCache = this.buildPayload(nowMs);
      this.onChange?.(this.payloadCache);
      if (nowMs - this.lastLiveSaveMs >= 15_000) {
        this.lastLiveSaveMs = nowMs;
        void this.persist();
      }
    }
  }

  sync(options: { force?: boolean; nowMs?: number } = {}): Promise<TokenActivityPayload> {
    if (this.syncingPromise) return this.syncingPromise;
    this.syncingPromise = this.runSync(options).finally(() => {
      this.syncingPromise = undefined;
    });
    return this.syncingPromise;
  }

  private async runSync({ force = false, nowMs = Date.now() }: { force?: boolean; nowMs?: number }): Promise<TokenActivityPayload> {
    await this.load();
    const minDate = cutoffDateKey(nowMs);
    if (force) {
      this.ledger.v17Rev = undefined;
      this.ledger.files = {};
      this.ledger.agFiles = {};
      this.ledger.fallbackDays = {};
    }

    // 1. Sync historical provider cache from T3 usage-scan-cache-v17.json first
    await this.syncFromT3V17(minDate);

    // 2. Priority local counting by Orrery across Gemini/Antigravity, OpenAI/Codex, and Claude transcripts
    await this.scanAntigravityLocal(minDate);
    await this.scanCodexLocal(minDate);
    await this.scanClaudeLocal(minDate);

    // 3. Backfill archived/pruned threads or stats from provider SQLite / stats caches without double-counting
    await this.syncProviderFallbacks(minDate);

    // Prune expired dates
    this.ledger.liveFloor = pruneDayMap(this.ledger.liveFloor, minDate);
    const nowIso = new Date(nowMs).toISOString();
    this.ledger.updatedAt = nowIso;
    this.ledger.lastSyncedAt = nowIso;
    this.payloadCache = this.buildPayload(nowMs);
    await this.persist();
    this.onChange?.(this.payloadCache);
    return this.payloadCache;
  }

  private async syncFromT3V17(minDate: string) {
    const file = path.join(this.config.t3UserDataDir, 'usage-scan-cache-v17.json');
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) return;
    const rev = `${info.mtimeMs}:${info.size}`;
    if (rev === this.ledger.v17Rev) return;

    const cache = record(await readJsonFile(file));
    if (cache.version !== 17) return;
    const models = Array.isArray(cache.models) ? cache.models : [];
    const seenByProvider = new Map<string, Set<string>>();

    let count = 0;
    for (const [rawPath, rawEntry] of Object.entries(record(cache.files))) {
      count++;
      if (count % 500 === 0) await yieldEventLoop();
      const entry = record(rawEntry);
      const rawProv = stringValue(entry.p) ?? 'other';
      const key = canonicalKey(rawPath);
      const m = numberValue(entry.m) ?? 0;
      const s = numberValue(entry.s) ?? 0;
      const existing = this.ledger.files[key];
      // Preserve Orrery's direct local parse if it is already at least as fresh as v17's snapshot.
      if (existing?.o === 'orrery' && existing.m >= m && existing.s >= s) continue;

      const seen = seenByProvider.get(rawProv) ?? new Set<string>();
      seenByProvider.set(rawProv, seen);
      const fileDays: FileDayMap = {};

      for (const bucket of [entry.r, entry.t]) {
        if (!Array.isArray(bucket)) continue;
        for (const row of bucket) {
          if (!Array.isArray(row)) continue;
          const [time, modelIndex, , uncached, cached, creation, output, , dedupeKey] = row;
          if (typeof dedupeKey === 'string') {
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
          }
          const ts = numberValue(time);
          if (ts === undefined) continue;
          const date = toLocalDateKey(ts);
          if (date < minDate) continue;
          const input = (numberValue(uncached) ?? 0) + (numberValue(creation) ?? 0);
          const cacheRead = numberValue(cached) ?? 0;
          const generated = numberValue(output) ?? 0;
          const total = input + cacheRead + generated;
          if (total <= 0) continue;
          const modelName = stringValue(models[numberValue(modelIndex) ?? -1]);
          const provider = classifyTokenProvider(modelName, rawProv);
          addTuple(fileDays, date, provider, input, cacheRead, generated, total, 1);
        }
      }
      this.ledger.files[key] = { m, s, o: 'provider', d: fileDays };
    }
    this.ledger.v17Rev = rev;
  }

  private async scanAntigravityLocal(minDate: string) {
    const providersDir = path.join(this.config.t3UserDataDir, 'providers', 'antigravity');
    const providerSubs = await readdir(providersDir, { withFileTypes: true }).catch(() => []);
    const roots = [
      path.join(this.config.geminiDir, 'antigravity', 'brain'),
      ...providerSubs.filter(d => d.isDirectory()).map(d => path.join(providersDir, d.name, 'antigravity-acp', 'brain')),
    ];

    const discovered = new Set<string>();
    let parsedCount = 0;
    for (const root of roots) {
      const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const dir of sessions) {
        if (!dir.isDirectory()) continue;
        const tf = path.join(root, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
        const info = await stat(tf).catch(() => undefined);
        if (!info?.isFile()) continue;
        const key = canonicalKey(tf);
        discovered.add(key);
        const prev = this.ledger.agFiles[key];
        if (prev && Math.abs(prev.m - info.mtimeMs) < 1 && prev.s === info.size) continue;

        const steps = await parseAntigravitySteps(tf, info.mtimeMs, minDate);
        this.ledger.agFiles[key] = { m: info.mtimeMs, s: info.size, steps };
        parsedCount++;
        if (parsedCount % 20 === 0) await yieldEventLoop();
      }
    }
    for (const key of Object.keys(this.ledger.agFiles)) {
      if (!discovered.has(key)) delete this.ledger.agFiles[key];
    }
  }

  private async scanCodexLocal(minDate: string) {
    const dirs = [
      path.join(this.config.codexDir, 'sessions'),
      path.join(this.config.codexDir, 'archived_sessions'),
    ];
    let parsedCount = 0;
    for (const base of dirs) {
      const entries = await readdir(base, { recursive: true, withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isFile() || !/^rollout-.*\.jsonl$/i.test(entry.name)) continue;
        const full = path.join(entry.parentPath, entry.name);
        const info = await stat(full).catch(() => undefined);
        if (!info?.isFile()) continue;
        const key = canonicalKey(full);
        const prev = this.ledger.files[key];
        if (prev && info.mtimeMs <= prev.m + 1 && info.size <= prev.s) continue;

        const days = await parseCodexRolloutDays(full, info.mtimeMs, minDate);
        this.ledger.files[key] = { m: info.mtimeMs, s: info.size, o: 'orrery', d: days };
        parsedCount++;
        if (parsedCount % 20 === 0) await yieldEventLoop();
      }
    }
  }

  private async scanClaudeLocal(minDate: string) {
    const projectsDir = path.join(this.config.claudeDir, 'projects');
    const entries = await readdir(projectsDir, { recursive: true, withFileTypes: true }).catch(() => []);
    let parsedCount = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const full = path.join(entry.parentPath, entry.name);
      const info = await stat(full).catch(() => undefined);
      if (!info?.isFile()) continue;
      const key = canonicalKey(full);
      const prev = this.ledger.files[key];
      if (prev && info.mtimeMs <= prev.m + 1 && info.size <= prev.s) continue;

      const days = await parseClaudeTranscriptDays(full, info.mtimeMs, minDate);
      this.ledger.files[key] = { m: info.mtimeMs, s: info.size, o: 'orrery', d: days };
      parsedCount++;
      if (parsedCount % 20 === 0) await yieldEventLoop();
    }
  }

  private async syncProviderFallbacks(minDate: string) {
    const fallback: FileDayMap = {};

    // Codex state_5.sqlite threads whose rollout file is missing/compressed and not in ledger.files
    withReadOnlyDb(path.join(this.config.codexDir, 'state_5.sqlite'), db => {
      const cols = tableColumns(db, 'threads');
      if (!cols.has('id') || !cols.has('tokens_used')) return true;
      const fields = ['id', 'rollout_path', 'created_at_ms', 'created_at', 'updated_at_ms', 'updated_at', 'model_provider', 'model', 'tokens_used']
        .filter(c => cols.has(c)).join(', ');
      for (const row of readRows(db, `SELECT ${fields} FROM threads WHERE tokens_used > 0`)) {
        const rollout = stringValue(row.rollout_path);
        if (rollout && this.ledger.files[canonicalKey(rollout)]) continue;
        const total = numberValue(row.tokens_used) ?? 0;
        if (total <= 0) continue;
        const ts = timestamp(row.created_at_ms ?? row.created_at ?? row.updated_at_ms ?? row.updated_at);
        if (!ts) continue;
        const date = toLocalDateKey(Date.parse(ts));
        if (date < minDate) continue;
        const provider = classifyTokenProvider(stringValue(row.model), stringValue(row.model_provider) ?? 'openai');
        addTuple(fallback, date, provider, 0, 0, 0, total, 1);
      }
      return true;
    });

    // Optional Claude stats-cache.json backfill for dates with no local Claude files
    const claudeStats = record(await readJsonFile(path.join(this.config.claudeDir, 'stats-cache.json')));
    if (Array.isArray(claudeStats.dailyModelTokens)) {
      const coveredClaudeDates = new Set<string>();
      for (const entry of Object.values(this.ledger.files)) {
        for (const [date, byProv] of Object.entries(entry.d)) {
          if (byProv.claude || byProv.deepseek) coveredClaudeDates.add(date);
        }
      }
      for (const raw of claudeStats.dailyModelTokens) {
        const item = record(raw);
        const date = stringValue(item.date);
        if (!date || date < minDate || coveredClaudeDates.has(date)) continue;
        for (const [model, count] of Object.entries(record(item.tokensByModel))) {
          const total = numberValue(count) ?? 0;
          if (total > 0) addTuple(fallback, date, classifyTokenProvider(model, 'claude'), 0, 0, 0, total, 1);
        }
      }
    }

    this.ledger.fallbackDays = fallback;
  }

  private buildPayload(nowMs = Date.now()): TokenActivityPayload {
    const minDate = cutoffDateKey(nowMs);
    const todayKey = toLocalDateKey(nowMs);
    const combined: FileDayMap = {};

    // Merge file buckets
    for (const entry of Object.values(this.ledger.files)) {
      for (const [date, byProv] of Object.entries(entry.d)) {
        if (date < minDate) continue;
        for (const [prov, t] of Object.entries(byProv)) {
          addTuple(combined, date, prov, t[0], t[1], t[2], t[3], t[4]);
        }
      }
    }

    // Merge deduplicated Antigravity session steps across brain roots
    const agSeen = new Map<string, Set<number>>();
    for (const [fileKey, entry] of Object.entries(this.ledger.agFiles)) {
      const parts = fileKey.split(/[\\/]/);
      const brainIdx = parts.lastIndexOf('brain');
      const sessionId = brainIdx >= 0 && parts[brainIdx + 1] ? parts[brainIdx + 1] : fileKey;
      const seen = agSeen.get(sessionId) ?? new Set<number>();
      agSeen.set(sessionId, seen);
      for (const [stepIndex, date, prov, input, cached, output] of entry.steps) {
        if (date < minDate || seen.has(stepIndex)) continue;
        seen.add(stepIndex);
        addTuple(combined, date, prov, input, cached, output, input + cached + output, 1);
      }
    }

    // Merge provider fallbacks
    for (const [date, byProv] of Object.entries(this.ledger.fallbackDays)) {
      if (date < minDate) continue;
      for (const [prov, t] of Object.entries(byProv)) {
        addTuple(combined, date, prov, t[0], t[1], t[2], t[3], t[4]);
      }
    }

    // Apply Orrery's live runtime floor (local-first priority)
    for (const [date, byProv] of Object.entries(this.ledger.liveFloor)) {
      if (date < minDate) continue;
      const target = (combined[date] ??= {});
      for (const [prov, floor] of Object.entries(byProv)) {
        const cur = target[prov];
        if (!cur) {
          target[prov] = [...floor];
        } else if (floor[3] > cur[3]) {
          target[prov] = [
            Math.max(cur[0], floor[0]),
            Math.max(cur[1], floor[1]),
            Math.max(cur[2], floor[2]),
            Math.max(cur[3], floor[3]),
            Math.max(cur[4], floor[4]),
          ];
        }
      }
    }

    const providerTotals = new Map<string, { totalTokens: number; todayTokens: number; activeDays: number }>();
    for (const core of CORE_TOKEN_PROVIDERS) {
      providerTotals.set(core.id, { totalTokens: 0, todayTokens: 0, activeDays: 0 });
    }

    const days: DailyTokenPoint[] = Object.keys(combined).sort().map(date => {
      const rawProvs = combined[date];
      const byProvider: Record<string, DailyProviderTokens> = {};
      let totalTokens = 0;
      let inputTokens = 0;
      let cachedTokens = 0;
      let outputTokens = 0;
      let calls = 0;
      for (const [prov, t] of Object.entries(rawProvs)) {
        if (t[3] <= 0) continue;
        byProvider[prov] = {
          inputTokens: t[0],
          cachedTokens: t[1],
          outputTokens: t[2],
          totalTokens: t[3],
          calls: t[4],
        };
        inputTokens += t[0];
        cachedTokens += t[1];
        outputTokens += t[2];
        totalTokens += t[3];
        calls += t[4];

        const meta = providerTotals.get(prov) ?? { totalTokens: 0, todayTokens: 0, activeDays: 0 };
        meta.totalTokens += t[3];
        if (date === todayKey) meta.todayTokens += t[3];
        meta.activeDays += 1;
        providerTotals.set(prov, meta);
      }
      return { date, totalTokens, inputTokens, cachedTokens, outputTokens, calls, byProvider };
    }).filter(day => day.totalTokens > 0);

    const coreIds = new Set(CORE_TOKEN_PROVIDERS.map(p => p.id));
    const providers: TokenProviderMeta[] = [
      ...CORE_TOKEN_PROVIDERS.map(core => ({
        id: core.id,
        name: core.name,
        ...providerTotals.get(core.id)!,
      })),
      ...[...providerTotals.entries()]
        .filter(([id, stats]) => !coreIds.has(id) && stats.totalTokens > 0)
        .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
        .map(([id, stats]) => ({
          id,
          name: TOKEN_PROVIDER_LABELS[id] ?? id,
          ...stats,
        })),
    ];

    return {
      updatedAt: this.ledger.updatedAt,
      ...(this.ledger.lastSyncedAt ? { lastSyncedAt: this.ledger.lastSyncedAt } : {}),
      days,
      providers,
    };
  }

  private persist(): Promise<void> {
    const snapshot = structuredClone(this.ledger);
    const write = this.pendingWrite.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(snapshot), 'utf8');
        await rename(temp, this.filePath);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.pendingWrite = write.catch(() => {});
    return this.pendingWrite;
  }
}
