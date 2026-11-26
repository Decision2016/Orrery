import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { OrreryConfig } from '../config.js';
import { agentRuntime, collectorOutput, numberValue, parseJson, readJsonFile, record, stringValue, timestamp } from './sqlite.js';
import type { CollectorAdapter } from './types.js';
import { cachedQuotaWindows, dayMs, summarizeUsage, type UsageSample } from './usage.js';

type PlannerSample = UsageSample & { stepIndex: number };

export class AntigravityAdapter implements CollectorAdapter {
  readonly id = 'antigravity';
  readonly name = 'Antigravity';
  readonly intervalMs = 5000;
  private readonly files = new Map<string, { mtimeMs: number; size: number; entries: PlannerSample[] }>();
  private modelSummary?: ReturnType<typeof summarizeUsage>;

  constructor(private readonly config: OrreryConfig,
    private readonly brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain')) {}

  async collect() {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const result = collectorOutput(this.id, at);
    const providersDir = path.join(this.config.t3UserDataDir, 'providers', this.id);
    const [providers, metadata] = await Promise.all([
      readdir(providersDir, { withFileTypes: true }).catch(() => []),
      readJsonFile(path.join(this.config.t3CachesDir, 'antigravity.json')),
    ]);
    const roots = [this.brainDir, ...providers.filter(dir => dir.isDirectory())
      .map(dir => path.join(providersDir, dir.name, 'antigravity-acp', 'brain'))];
    const transcripts = (await Promise.all(roots.map(async root => {
      const sessions = await readdir(root, { withFileTypes: true }).catch(() => []);
      return Promise.all(sessions.filter(dir => dir.isDirectory()).map(async dir => {
        const file = path.join(root, dir.name, '.system_generated', 'logs', 'transcript.jsonl');
        const info = await stat(file).catch(() => undefined);
        return info?.isFile() && info.mtimeMs >= now - dayMs
          ? { file, sessionId: dir.name, mtimeMs: info.mtimeMs, size: info.size } : undefined;
      }));
    }))).flat().filter(file => file !== undefined).sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
    const paths = new Set(transcripts.map(entry => entry.file));
    let changed = false;
    for (const file of this.files.keys()) {
      if (paths.has(file)) continue;
      this.files.delete(file);
      changed = true;
    }
    for (const { file, sessionId, mtimeMs, size } of transcripts) {
      const previous = this.files.get(file);
      if (previous?.mtimeMs === mtimeMs && previous.size === size) continue;
      const contents = await readFile(file, 'utf8').catch(() => undefined);
      if (contents === undefined) continue;
      const entries: PlannerSample[] = [];
      for (const [index, line] of contents.split('\n').entries()) {
        if (!line.includes('"PLANNER_RESPONSE"')) continue;
        const step = record(parseJson(line));
        const model = stringValue(step.model);
        if (step.type !== 'PLANNER_RESPONSE' || !model) continue;
        const time = timestamp(step.created_at);
        const at = time ? Date.parse(time) : Math.trunc(mtimeMs);
        if (at < now - dayMs) continue;
        const input = numberValue(step.input_tokens) ?? 0;
        const cached = numberValue(step.cache_read_tokens) ?? 0;
        const output = numberValue(step.output_tokens) ?? 0;
        entries.push({ providerId: this.id, providerName: this.name, model, sessionId,
          stepIndex: numberValue(step.step_index) ?? index, at, input, cached, output, total: input + cached + output });
      }
      this.files.set(file, { mtimeMs, size, entries });
      changed = true;
    }
    if (!this.modelSummary || changed || now >= this.modelSummary.validUntil) {
      const stepsBySession = new Map<string, Set<number>>();
      const samples: UsageSample[] = [];
      // Both roots can contain steps from the same brain session.
      for (const { file, sessionId } of transcripts) {
        const seen = stepsBySession.get(sessionId) ?? new Set<number>();
        stepsBySession.set(sessionId, seen);
        for (const entry of this.files.get(file)?.entries ?? []) {
          if (!seen.has(entry.stepIndex)) samples.push(entry);
          seen.add(entry.stepIndex);
        }
      }
      this.modelSummary = summarizeUsage(samples, now);
    }
    result.modelUsage = this.modelSummary.entries;
    result.todayTokens = result.modelUsage.reduce((sum, model) => sum + model.todayTokens, 0);
    const cache = record(metadata);
    if (!cachedQuotaWindows(cache, this.id).some(quota => quota.sourceMode === 'official-cache')) {
      result.quotas.push({ providerId: this.id, providerName: this.name, windowId: 'local-safe', label: '本地安全用量统计',
        usedPercent: 0, sourceMode: 'local-only', unavailableReason: '官方未落盘剩余额度；已禁用上游探针保护账号安全' });
    }
    const latest = transcripts[0]?.mtimeMs;
    const ready = cache.status === 'ready';
    const online = ready || (latest !== undefined && latest >= now - 600_000);
    const lastSeen = Math.max(latest ?? 0, ready ? Date.parse(timestamp(cache.checkedAt) ?? at) : 0);
    const agent = agentRuntime(this.id, this.name, online ? 'online' : 'offline', new Date(lastSeen || now).toISOString(), []);
    agent.detail = 'Passive local telemetry from Antigravity transcripts and the T3 provider cache';
    result.agents.push(agent);
    return result;
  }
}
