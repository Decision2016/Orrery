import { useId, useMemo } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import type { TokenRatePoint } from '@orrery/shared';
import { formatClock, formatTokens } from '../../lib/format';
import { EmptyState } from '../Telemetry';

export function TokenChartWidget({ history }: { history: TokenRatePoint[] }) {
  const gradient = useId();
  const series = useMemo(() => history.map(p => ({ ...p, time: Date.parse(p.timestamp) }))
    .filter(p => Number.isFinite(p.time)).sort((a, b) => a.time - b.time), [history]);
  const last = series.at(-1);
  if (!last) return <EmptyState icon={ChartNoAxesCombined}>等待 Token 速率采样</EmptyState>;
  const first = series[0];
  const peak = Math.max(...series.map(p => p.tokensPerMin));
  const maxTasks = Math.max(...series.map(p => p.activeTasks));
  const average = series.reduce((sum, p) => sum + p.tokensPerMin, 0) / series.length;
  const width = 640, height = 114;
  const x = (time: number) => last.time === first.time ? width : (time - first.time) / (last.time - first.time) * width;
  const y = (value: number, max: number) => height - value / Math.max(1, max) * (height - 5);
  const line = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.time)},${y(p.tokensPerMin, peak)}`).join(' ');
  const active = series.map((p, i) => `${i ? 'L' : 'M'}${x(p.time)},${y(p.activeTasks, maxTasks)}`).join(' ');
  return <div className="widget-scroll padded burn-widget">
    <dl className="burn-kpis">{[['当前', last.tokensPerMin], ['峰值', peak], ['平均', average]].map(([label, value]) =>
      <div key={label}><dt>{label}</dt><dd>{formatTokens(Number(value))}<em> tok/min</em></dd></div>)}</dl>
    <div className="chart-legend"><span className="tone-cyan"><i />Tokens/min</span><span className="tone-violet"><i />并发任务</span></div>
    <figure className="burn-chart"><div className="chart-y"><span>{formatTokens(peak)}</span><span>{formatTokens(peak / 2)}</span><span>0</span></div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`Token 速率与并发任务，当前每分钟 ${last.tokensPerMin} tokens、${last.activeTasks} 个任务`}>
        <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--cyan)" stopOpacity=".32" /><stop offset="100%" stopColor="var(--cyan)" stopOpacity=".025" /></linearGradient></defs>
        {[1, height / 2, height - 1].map(tick => <path key={tick} d={`M0 ${tick}H${width}`} className="chart-grid" />)}
        <path d={line + ` L${width},${height} L${x(first.time)},${height} Z`} fill={`url(#${gradient})`} />
        <path d={active} className="active-line" /><path d={line} className="token-line" />
        <circle cx={width - 2} cy={y(last.activeTasks, maxTasks)} r="2.6" fill="var(--violet)" /><circle cx={width - 2} cy={y(last.tokensPerMin, peak)} r="2.8" fill="var(--cyan)" />
      </svg><div className="chart-y right"><span>{maxTasks}</span><span>0</span></div>
      <figcaption><time>{formatClock(first.time, false)}</time>{first.time !== last.time && <time>{formatClock(last.time, false)}</time>}</figcaption>
    </figure>
  </div>;
}
