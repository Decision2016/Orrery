import { useState } from 'react';
import { Box, ChevronDown, ChevronRight, Square, Terminal } from 'lucide-react';
import type { AgentRuntime, ProcessMetric } from '@orrery/shared';
import { EmptyState, Sparkline } from '../Telemetry';
import { killAgentProcess } from '../../lib/api';
import { formatRelativeTime } from '../../lib/format';

export function AgentsWidget({
  agents,
  processes = [],
  onNotice,
}: {
  agents: AgentRuntime[];
  processes?: ProcessMetric[];
  onNotice?: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [confirmPid, setConfirmPid] = useState<number | null>(null);
  const [killingPid, setKillingPid] = useState<number | null>(null);

  if (!agents.length) return <EmptyState icon={Box}>尚未发现 Agent 实例</EmptyState>;
  return <div className="widget-scroll agent-list">{agents.map(agent => {
    const tone = { online: 'tone-green', degraded: 'tone-amber', offline: 'tone-muted' }[agent.status];
    const identity = /codex/i.test(agent.name) ? 'tone-green' : /t3/i.test(agent.name) ? 'tone-blue' : 'tone-violet';
    const procs = processes.filter(p => p.agentId === agent.id).sort((a, b) => b.memoryMb - a.memoryMb);
    const isOpen = Boolean(expanded[agent.id]);
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
      {procs.length > 0 && <div className="agent-processes">
        <button className="proc-toggle" aria-expanded={isOpen} onClick={() => setExpanded(prev => ({ ...prev, [agent.id]: !prev[agent.id] }))}>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>活跃进程 ({procs.length})</span>
        </button>
        {isOpen && <ul className="proc-list">{procs.map(proc => {
          const confirming = confirmPid === proc.pid;
          const busy = killingPid === proc.pid;
          return <li key={proc.pid} className="proc-row">
            <div className="proc-info">
              <span className="mono proc-name" title={proc.commandLine ?? proc.name}>{proc.role || proc.name}</span>
              <small className="mono">PID {proc.pid} · {Math.round(proc.memoryMb)} MB</small>
            </div>
            <button className={`proc-kill ${confirming ? 'is-confirm' : ''}`} disabled={busy}
              title={confirming ? '再次点击确认结束此进程' : `结束进程 PID ${proc.pid}`}
              onClick={async () => {
                if (!confirming) { setConfirmPid(proc.pid); return; }
                setKillingPid(proc.pid);
                try {
                  await killAgentProcess(proc.pid);
                  onNotice?.(`已请求结束进程 PID ${proc.pid} (${proc.name})`);
                } catch (error) {
                  onNotice?.(error instanceof Error ? error.message : '结束进程失败');
                } finally {
                  setKillingPid(null);
                  setConfirmPid(null);
                }
              }}>
              <Square size={10} /><span>{busy ? '结束中' : confirming ? '确认结束' : '结束'}</span>
            </button>
          </li>;
        })}</ul>}
      </div>}
    </article>;
  })}</div>;
}
