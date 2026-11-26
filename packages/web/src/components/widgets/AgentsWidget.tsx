import { Box, Terminal } from 'lucide-react';
import type { AgentRuntime } from '@orrery/shared';
import { EmptyState, Sparkline } from '../Telemetry';
import { formatRelativeTime } from '../../lib/format';

export function AgentsWidget({ agents }: { agents: AgentRuntime[] }) {
  if (!agents.length) return <EmptyState icon={Box}>尚未发现 Agent 实例</EmptyState>;
  return <div className="widget-scroll agent-list">{agents.map(agent => {
    const tone = { online: 'tone-green', degraded: 'tone-amber', offline: 'tone-muted' }[agent.status];
    const identity = /codex/i.test(agent.name) ? 'tone-green' : /t3/i.test(agent.name) ? 'tone-blue' : 'tone-violet';
    return <article className="agent-card" key={agent.id}>
      <div className="agent-identity"><span className={`agent-icon ${identity}`}><Terminal size={17} /></span>
        <div className="min-w-0"><h3>{agent.name}</h3><small className="mono" title={agent.detail}>{agent.version ?? '版本未知'}</small></div>
        <span className={`health ${tone}`} title={'最近观测 · ' + formatRelativeTime(agent.lastSeenAt)}><i className={`dot ${agent.status === 'online' ? 'pulse' : ''}`} />{agent.status}</span>
      </div>
      <dl className="agent-counts">{[
        ['运行', agent.runningCount], ['等待', agent.waitingCount], ['队列', agent.queuedCount], ['子代理', agent.subagentCount],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="agent-resources">
        <div><small>CPU</small><b>{agent.cpuPercent.toFixed(1)}<em>%</em></b><Sparkline values={agent.cpuHistory} tone="tone-cyan" label={agent.name + ' CPU 趋势'} /></div>
        <div><small>MEM</small><b>{Math.round(agent.memoryMb)}<em> MB</em></b><Sparkline values={agent.memoryHistory} tone="tone-violet" label={agent.name + ' 内存趋势'} /></div>
      </div>
    </article>;
  })}</div>;
}
