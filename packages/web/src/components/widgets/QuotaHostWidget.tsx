import { Cpu, HardDrive, MemoryStick, Timer } from 'lucide-react';
import type { HostMetrics, QuotaWindow } from '@orrery/shared';
import { formatDuration } from '../../lib/format';
import { QuotaReading } from '../QuotaReading';
import { Meter } from '../Telemetry';

export function QuotaHostWidget({ quotas, host }: { quotas: QuotaWindow[]; host: HostMetrics }) {
  return <div className="widget-scroll padded quota-widget">
    <h3 className="section-label">Provider 配额</h3>
    {quotas.length ? quotas.map(q => <QuotaReading key={q.providerId + '/' + q.windowId} quota={q} />)
      : <p className="muted quiet-line">暂无 Provider 配额数据</p>}
    <h3 className="section-label ruled">主机资源</h3>
    <div className="host-row"><div className="between"><span><Cpu size={14} />CPU</span><b>{host.cpuPercent.toFixed(1)}%</b></div>
      <Meter value={host.cpuPercent} tone={host.cpuPercent >= 90 ? 'tone-rose' : 'tone-cyan'} /></div>
    <div className="host-row"><div className="between"><span><MemoryStick size={14} />内存</span>
      <b>{host.memoryUsedGb.toFixed(1)} <small>/ {host.memoryTotalGb.toFixed(1)} GB</small></b></div>
      <Meter value={host.memoryPercent} tone="tone-violet" /></div>
    <dl className="host-stats"><div><dt><HardDrive size={13} />Agent 进程</dt><dd>{host.agentProcessCount}</dd></div>
      <div><dt><Timer size={13} />运行时长</dt><dd>{formatDuration(host.uptimeSec * 1000)}</dd></div></dl>
  </div>;
}
