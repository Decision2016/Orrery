import { ShieldCheck, Timer } from 'lucide-react';
import type { QuotaWindow } from '@orrery/shared';
import { useNow } from '../hooks/useNow';
import { formatCountdown, formatPercent, formatTokens, remainingQuotaTone } from '../lib/format';
import { Meter } from './Telemetry';

export function QuotaReading({ quota, localUsage }: {
  quota: QuotaWindow;
  localUsage?: { tokens: number; calls: number };
}) {
  const now = useNow();
  const { providerName, label, planType, usedPercent, remainingPercent, resetsAt, unavailableReason } = quota;
  const local = quota.sourceMode === 'local-only';
  const value = remainingPercent ?? (unavailableReason ? undefined : usedPercent);
  const tone = remainingPercent !== undefined ? remainingQuotaTone(remainingPercent)
    : usedPercent >= 90 ? 'tone-rose' : usedPercent >= 70 ? 'tone-amber' : 'tone-green';

  return <article className="quota-reading">
    <header className="quota-heading">
      <h4>{providerName} <span>{label}</span></h4>
      {planType && <span className="quota-plan mono">{planType}</span>}
    </header>
    {local ? <>
      <span className="local-quota-badge" title={['为保护账号，仅汇总本机记录，不主动探测官方额度。', unavailableReason].filter(Boolean).join(' ')}>
        <ShieldCheck size={14} />本地安全统计 · 无伪造探针
      </span>
      {localUsage && <p className="local-quota-totals"><span>24h</span> <b>{formatTokens(localUsage.tokens)}</b> tokens · <b>{localUsage.calls}</b> 次调用</p>}
    </> : <>
      {value !== undefined && <>
        <div className="quota-values">
          <strong className={`mono ${tone}`}>{remainingPercent !== undefined ? '剩余' : '已用'} {formatPercent(value)}</strong>
          {remainingPercent !== undefined && <span>已用 {formatPercent(usedPercent)}</span>}
        </div>
        <Meter value={value} tone={tone} />
      </>}
      {resetsAt && <div className="reset-time"><Timer size={11} />重置 <time dateTime={resetsAt} title={resetsAt}>{formatCountdown(resetsAt, now)}</time></div>}
      {unavailableReason && <p className="quota-note">{unavailableReason}</p>}
    </>}
  </article>;
}
