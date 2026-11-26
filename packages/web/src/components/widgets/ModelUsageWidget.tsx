import { useState } from 'react';
import { Check, Gauge, SlidersHorizontal } from 'lucide-react';
import type { ModelUsageEntry, QuotaWindow } from '@orrery/shared';
import { formatPercent, formatTokens, remainingQuotaTone } from '../../lib/format';
import { readLocal, writeLocal } from '../../lib/storage';
import { QuotaReading } from '../QuotaReading';
import { EmptyState, Meter } from '../Telemetry';

const VISIBILITY_KEY = 'orrery.quotaVisibility';

function loadVisibility(): Record<string, boolean> {
  const saved = readLocal(VISIBILITY_KEY);
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, boolean>) : {};
}

function quotaKey(quota: QuotaWindow) {
  return `${quota.providerId}/${quota.windowId}`;
}

function isQuotaVisible(quota: QuotaWindow, prefs: Record<string, boolean>) {
  const key = quotaKey(quota);
  if (key in prefs) return prefs[key];
  // Custom API endpoints (e.g. Claude Code backed by DeepSeek API) have no fixed subscription quota; hide by default.
  return quota.windowId !== 'custom_api';
}

export function ModelUsageWidget({ quotas, modelUsage }: { quotas: QuotaWindow[]; modelUsage: ModelUsageEntry[] }) {
  const [period, setPeriod] = useState<'tokens24h' | 'todayTokens'>('tokens24h');
  const [visibility, setVisibility] = useState<Record<string, boolean>>(loadVisibility);
  const [configuring, setConfiguring] = useState(false);

  const visibleQuotas = quotas.filter(q => isQuotaVisible(q, visibility));
  const hiddenCount = quotas.length - visibleQuotas.length;

  const toggleQuota = (quota: QuotaWindow) => {
    const key = quotaKey(quota);
    const next = { ...visibility, [key]: !isQuotaVisible(quota, visibility) };
    setVisibility(next);
    writeLocal(VISIBILITY_KEY, next);
  };

  const models = [...modelUsage].sort((a, b) => b[period] - a[period] || a.model.localeCompare(b.model));
  const total = models.reduce((sum, entry) => sum + entry[period], 0);
  const available = visibleQuotas.filter((q): q is QuotaWindow & { remainingPercent: number } =>
    q.sourceMode !== 'local-only' && q.remainingPercent !== undefined
  ).sort((a, b) => a.remainingPercent - b.remainingPercent);

  return <div className="widget-column model-usage-widget">
    <section className="model-quotas" aria-label="剩余额度">
      <div className="model-quotas-head">
        <h3 className="model-section-heading">剩余额度</h3>
        {quotas.length > 0 && (
          <button
            className={`quota-config-btn ${configuring ? 'is-active' : ''}`}
            aria-expanded={configuring}
            title="选择要显示或隐藏的额度卡片"
            onClick={() => setConfiguring(v => !v)}
          >
            <SlidersHorizontal size={12} />
            <span>显示项{hiddenCount > 0 ? ` (${visibleQuotas.length}/${quotas.length})` : ''}</span>
          </button>
        )}
      </div>
      {configuring && quotas.length > 0 && (
        <div className="quota-filter-bar" role="group" aria-label="额度卡片显示设置">
          {quotas.map(q => {
            const shown = isQuotaVisible(q, visibility);
            const shortLabel = q.windowId === 'custom_api'
              ? `${q.providerName} (${q.label.replace(/^API\s*·\s*/i, '')})`
              : q.sourceMode === 'local-only'
                ? q.providerName
                : `${q.providerName} · ${q.label}`;
            return (
              <button
                key={quotaKey(q)}
                className={`quota-toggle-chip ${shown ? 'is-on' : ''}`}
                aria-pressed={shown}
                onClick={() => toggleQuota(q)}
              >
                {shown && <Check size={11} />}
                <span>{shortLabel}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="widget-scroll model-quota-list">
        {visibleQuotas.length ? visibleQuotas.map(quota => {
          const localUsage = quota.sourceMode === 'local-only' ? modelUsage.filter(m =>
            m.providerId === quota.providerId || (quota.providerId === 'claudeAgent' && /claude|deepseek/i.test(m.providerId + ' ' + m.model))
          ).reduce((sum, m) => ({ tokens: sum.tokens + m.tokens24h, calls: sum.calls + m.calls24h }), { tokens: 0, calls: 0 }) : undefined;
          return <QuotaReading key={quotaKey(quota)} quota={quota} localUsage={localUsage} />;
        }) : <p className="model-empty">{quotas.length ? '已隐藏全部额度卡片，点击右上角「显示项」重新开启' : '暂无额度窗口'}</p>}
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
