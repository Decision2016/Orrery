import type { ModelUsageEntry, QuotaWindow } from '@orrery/shared';
import { brief, numberValue, record, stringValue, timestamp } from './sqlite.js';

export const dayMs = 86_400_000;

export interface UsageSample {
  providerId: string;
  providerName: string;
  model: string;
  sessionId: string;
  at: number;
  input: number;
  cached: number;
  output: number;
  total: number;
  calls?: number;
  // A database-only lifetime counter can only be attributed to periods containing its start.
  counterStartedAt?: number;
}

export function summarizeUsage(samples: UsageSample[], now: number) {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  let validUntil = new Date(now).setHours(24, 0, 0, 0);
  const groups = new Map<string, { entry: ModelUsageEntry; sessions: Set<string>; last: number }>();
  for (const sample of samples) {
    if (sample.at < now - dayMs) continue;
    if (sample.at > now) {
      validUntil = Math.min(validUntil, sample.at);
      continue;
    }
    const { providerId, providerName, model } = sample;
    const key = JSON.stringify([providerId, model]);
    let group = groups.get(key);
    if (!group) {
      group = { entry: { providerId, providerName, model, todayTokens: 0, tokens24h: 0, inputTokens24h: 0,
        cachedTokens24h: 0, outputTokens24h: 0, calls24h: 0, sessions24h: 0 }, sessions: new Set(), last: 0 };
      groups.set(key, group);
    }
    const { entry, sessions } = group;
    const start = sample.counterStartedAt ?? sample.at;
    if (start >= now - dayMs) {
      entry.tokens24h += sample.total;
      entry.inputTokens24h += sample.input;
      entry.cachedTokens24h += sample.cached;
      entry.outputTokens24h += sample.output;
      entry.calls24h += sample.calls ?? 1;
      validUntil = Math.min(validUntil, start + dayMs + 1);
    }
    if (start >= midnight) entry.todayTokens += sample.total;
    sessions.add(sample.sessionId);
    group.last = Math.max(group.last, sample.at);
    validUntil = Math.min(validUntil, sample.at + dayMs + 1);
  }
  const entries = Array.from(groups.values(), ({ entry, sessions, last }) => ({
    ...entry, sessions24h: sessions.size, lastUsedAt: new Date(last).toISOString(),
  }));
  return { entries, validUntil };
}

export function cachedQuotaWindows(cache: Record<string, unknown>, fallbackId: string): QuotaWindow[] {
  const limits = record(cache.usageLimits);
  if (!Array.isArray(limits.windows)) return [];
  const providerId = stringValue(cache.instanceId) ?? fallbackId;
  const providerName = stringValue(cache.displayName) ?? providerId;
  const checkedAt = timestamp(limits.checkedAt ?? cache.checkedAt);
  const unavailable = record(limits.unavailable);
  const unavailableReason = brief(unavailable.message) ?? brief(unavailable.reason) ?? brief(limits.unavailable);
  if (!limits.windows.length && cache.enabled === true && limits.unavailable) {
    return [{ providerId, providerName, checkedAt, windowId: 'local-safe', label: '本地安全用量统计',
      usedPercent: 0, sourceMode: 'local-only', unavailableReason: unavailableReason ?? '本地缓存未提供剩余额度' }];
  }
  return limits.windows.flatMap((raw): QuotaWindow[] => {
    const window = record(raw);
    const windowId = stringValue(window.id) ?? stringValue(window.kind);
    const used = numberValue(window.usedPercent);
    if (!windowId || used === undefined) return [];
    const kind = stringValue(window.kind);
    const label = stringValue(window.label) ?? windowId;
    const resetsAt = timestamp(window.resetsAt);
    if (windowId === 'custom_api' || (kind === 'other' && /^API\s*·/i.test(label) && !resetsAt)) {
      return [{ providerId, providerName, windowId, label, usedPercent: 0, checkedAt,
        sourceMode: 'local-only', unavailableReason: '自定义 API（无固定订阅额度）' }];
    }
    const usedPercent = Math.max(0, Math.min(100, used));
    return [{ providerId, providerName, windowId, label,
      usedPercent, remainingPercent: 100 - usedPercent, windowDurationMins: numberValue(window.windowDurationMins),
      planType: stringValue(limits.planType), resetsAt, checkedAt,
      sourceMode: 'official-cache', unavailableReason }];
  });
}
