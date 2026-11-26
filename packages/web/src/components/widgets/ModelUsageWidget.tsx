import { useState } from 'react';
import { Gauge } from 'lucide-react';
import type { ModelUsageEntry, QuotaWindow } from '@orrery/shared';
import { formatPercent, formatTokens, remainingQuotaTone } from '../../lib/format';
import { QuotaReading } from '../QuotaReading';
import { EmptyState, Meter } from '../Telemetry';

export function ModelUsageWidget({ quotas, modelUsage }: { quotas: QuotaWindow[]; modelUsage: ModelUsageEntry[] }) {
  const [period, setPeriod] = useState<'tokens24h' | 'todayTokens'>('tokens24h');
  const models = [...modelUsage].sort((a, b) => b[period] - a[period] || a.model.localeCompare(b.model));
  const total = models.reduce((sum, entry) => sum + entry[period], 0);
  const available = quotas.filter((q): q is QuotaWindow & { remainingPercent: number } =>
    q.sourceMode !== 'local-only' && q.remainingPercent !== undefined
  ).sort((a, b) => a.remainingPercent - b.remainingPercent);

  return <div className="widget-column model-usage-widget">
    <section className="model-quotas" aria-label="剩余额度">
      <h3 className="model-section-heading">剩余额度</h3>
      <div className="widget-scroll model-quota-list">
        {quotas.length ? quotas.map(quota => {
          const localUsage = quota.sourceMode === 'local-only' ? modelUsage.filter(m => m.providerId === quota.providerId)
            .reduce((sum, m) => ({ tokens: sum.tokens + m.tokens24h, calls: sum.calls + m.calls24h }), { tokens: 0, calls: 0 }) : undefined;
          return <QuotaReading key={quota.providerId + '/' + quota.windowId} quota={quota} localUsage={localUsage} />;
        }) : <p className="model-empty">暂无额度窗口</p>}
      </div>
    </section>
    <section className="widget-column" aria-label="各模型用量">
      <div className="widget-toolbar model-toolbar">
        <h3 className="model-section-heading">各模型用量</h3>
        <div className="segments mono" role="group" aria-label="模型用量时段">
          <button aria-pressed={period === 'tokens24h'} onClick={() => setPeriod('tokens24h')}>24h</button>
          <button aria-pressed={period === 'todayTokens'} onClick={() => setPeriod('todayTokens')}>今日</button>
        </div>
      </div>
      {models.length ? <ol className="widget-scroll model-list">{models.map(entry => {
        const share = total > 0 ? entry[period] / total * 100 : 0;
        const providerWindows = available.filter(q => q.providerId === entry.providerId);
        const quota = providerWindows.find(q => q.windowId === entry.quotaWindowId) ?? providerWindows[0];
        const input = entry.inputTokens24h + entry.cachedTokens24h;
        return <li key={entry.providerId + '/' + entry.model} className="model-row" data-provider={entry.providerId}>
          <div className="model-summary">
            <h4>{entry.model}</h4>
            <strong className="model-amount mono" title={entry[period].toLocaleString() + ' tokens'}>{formatTokens(entry[period])} <small>tok</small></strong>
          </div>
          <div className="model-share">
            <span className="provider-pill">{entry.providerName}</span>
            {quota && <span className={`quota-pill ${remainingQuotaTone(quota.remainingPercent)}`} title={`${quota.providerName} · ${quota.label} · 剩余 ${formatPercent(quota.remainingPercent)}`}>余 {formatPercent(quota.remainingPercent)}</span>}
            <Meter value={share} tone="model-share-meter" />
            <span className="share-percent mono" title="占所选时段全部模型 Token 的比例">{share > 0 && share < 0.1 ? '<0.1%' : formatPercent(share)}</span>
          </div>
          <p className="model-telemetry">
            <span className="detail-period">24h</span>
            <span>输入 <b>{formatTokens(entry.inputTokens24h)}</b></span>
            <span>缓存 <b>{formatTokens(entry.cachedTokens24h)}</b></span>
            <span>输出 <b>{formatTokens(entry.outputTokens24h)}</b></span>
            {entry.cachedTokens24h > 0 && <span>命中 <b>{formatPercent(entry.cachedTokens24h / input * 100)}</b></span>}
            <span>{entry.calls24h > 0 || entry.sessions24h === 0 ? `${entry.calls24h} 次调用` : `${entry.sessions24h} 会话`}</span>
          </p>
        </li>;
      })}</ol> : <EmptyState icon={Gauge}>暂无模型用量记录</EmptyState>}
    </section>
  </div>;
}
