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
  const subLabel = local ? undefined : label.replace(/^API\s*·\s*/i, '');

  return <article className="quota-reading">
    <header className="quota-heading">
      <h4 title={[providerName, label].filter(Boolean).join(' · ')}>
        {providerName}
        {subLabel && <span>{subLabel}</span>}
      </h4>
      {local ? (
        <span className="local-quota-badge" title={['为保护账号，仅汇总本机记录，不伪造上游探针。', unavailableReason].filter(Boolean).join(' ')}>
          <ShieldCheck size={12} />安全本地
        </span>
      ) : planType ? (
        <span className="quota-plan mono">{planType}</span>
      ) : null}
    </header>
    {local ? (
      <>
        <div className="quota-values">
          <strong className="tone-violet">
            <span className="mono">{formatTokens(localUsage?.tokens ?? 0)}</span>
            <small className="quota-unit">24h tok</small>
          </strong>
          {localUsage && <span>{localUsage.calls.toLocaleString()} 次</span>}
        </div>
        <div className="quota-foot muted" title={unavailableReason ?? '仅统计本地落盘用量，不伪造上游配额探针'}>
          仅本地用量 · 无伪造探针
        </div>
      </>
    ) : (
      <>
        {value !== undefined && (
          <>
            <div className="quota-values">
              <strong className={tone}>
                <em className="quota-prefix">{remainingPercent !== undefined ? '剩余' : '已用'}</em>
                <span className="mono">{formatPercent(value)}</span>
              </strong>
              {remainingPercent !== undefined && <span>已用 {formatPercent(usedPercent)}</span>}
            </div>
            <Meter value={value} tone={tone} />
          </>
        )}
        <div className="quota-foot">
          {resetsAt ? (
            <span className="reset-time"><Timer size={11} />重置 <time dateTime={resetsAt} title={resetsAt}>{formatCountdown(resetsAt, now)}</time></span>
          ) : unavailableReason ? (
            <span className="quota-note">{unavailableReason}</span>
          ) : (
            <span className="reset-time">持续统计</span>
          )}
        </div>
      </>
    )}
  </article>;
}
