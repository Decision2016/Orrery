import type { SourceKind, TaskStatus } from '@orrery/shared';

const statuses = {
  running: ['运行中', 'tone-cyan'],
  waiting_approval: ['待审批', 'tone-amber'],
  waiting_input: ['待输入', 'tone-amber'],
  queued: ['排队中', 'tone-blue'],
  completed: ['已完成', 'tone-green'],
  failed: ['失败', 'tone-rose'],
  interrupted: ['已中断', 'tone-rose'],
  cancelled: ['已取消', 'tone-muted'],
  stale: ['无响应', 'tone-amber'],
} satisfies Record<TaskStatus, [string, string]>;

export const statusLabel = (status: TaskStatus) => statuses[status][0];
export const statusColorClass = (status: TaskStatus) => statuses[status][1];
export const isActive = (s: TaskStatus) => s === 'running' || s === 'waiting_approval' || s === 'waiting_input';
export const isAbnormal = (s: TaskStatus) => s === 'failed' || s === 'interrupted' || s === 'stale';
export const percent = (n: number) => Math.min(100, Math.max(0, n));
export const formatPercent = (n: number) => `${+n.toFixed(1)}%`;
export const remainingQuotaTone = (n: number) => n > 40 ? 'tone-green' : n >= 15 ? 'tone-amber' : 'tone-rose';

export const sourceNames: Record<SourceKind, string> = {
  t3: 'T3 Code', 't3-codex': 'T3 → Codex', 'codex-app': 'Codex App', 'codex-cli': 'Codex CLI',
  'claude-code': 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity',
};

export function formatDuration(ms: number) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function formatTokens(n: number) {
  if (!Number.isFinite(n)) return '—';
  const magnitude = Math.abs(n);
  if (magnitude >= 1_000_000_000) return `${+(n / 1_000_000_000).toFixed(2)}B`;
  if (magnitude >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (magnitude >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatRelativeTime(iso: string, now = Date.now()) {
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return '—';
  if (Math.abs(elapsed) < 1000) return '刚刚';
  return formatDuration(Math.abs(elapsed)) + (elapsed >= 0 ? ' 前' : ' 后');
}

export function formatCountdown(iso?: string, now = Date.now()) {
  if (!iso) return '—';
  const remaining = Date.parse(iso) - now;
  return remaining <= 0 ? '已到时' : formatDuration(remaining);
}

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function formatClock(value: string | number, seconds = true) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '—';
  const time = clock.format(ms);
  return seconds ? time : time.slice(0, 5);
}

export function shortenPath(path: string) {
  const clean = path.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  const root = clean.match(/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?|[\\/])/)?.[0] ?? '';
  const parts = clean.slice(root.length).split(/[\\/]+/).filter(Boolean);
  if (parts.length <= (root ? 2 : 3)) return clean;
  const separator = clean.includes('\\') ? '\\' : '/';
  return (root || parts[0] + separator) + ['…', ...parts.slice(-2)].join(separator);
}
