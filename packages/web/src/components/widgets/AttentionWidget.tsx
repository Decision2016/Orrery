import { BellRing, ChevronRight, FolderOpen, ShieldCheck, Timer } from 'lucide-react';
import type { AttentionAlert } from '@orrery/shared';
import { useNow } from '../../hooks/useNow';
import { formatDuration } from '../../lib/format';
import { EmptyState, OpenAction, SourceBadge } from '../Telemetry';

const kinds = { approval: '待审批', user_input: '待输入', proposed_plan: '待确认计划', failed: '执行失败', stale: '长时间无更新' };

export function AttentionWidget({ alerts, total, onSelect, connected }: { alerts: AttentionAlert[]; total: number; onSelect: (id: string) => void; connected: boolean }) {
  const now = useNow();
  if (!alerts.length) {
    if (total) return <EmptyState icon={BellRing}>当前筛选下没有告警</EmptyState>;
    if (!connected) return <EmptyState icon={BellRing}>最近快照无告警 · 等待重新连接</EmptyState>;
    return <div className="all-clear"><span className="clear-icon"><ShieldCheck size={26} strokeWidth={1.4} /></span><div><strong>All Clear</strong><span>全部任务运行顺畅</span></div></div>;
  }
  return <div className="widget-scroll card-list">{alerts.map(alert => {
    const age = now - Date.parse(alert.createdAt);
    return <article className={`alert-card ${alert.severity === 'critical' || alert.kind === 'failed' ? 'critical' : ''}`} key={alert.id}>
      <button className="alert-select" onClick={() => onSelect(alert.taskId)}>
        <span className="alert-top"><span className="alert-kind"><i className="dot pulse" />{kinds[alert.kind]}</span>
          <SourceBadge source={alert.source} /><time><Timer size={12} />{formatDuration(Number.isFinite(age) ? age : alert.ageMs)}</time></span>
        <strong className="alert-title">{alert.title}<ChevronRight size={15} /></strong>
        {alert.detail && <span className="alert-detail">{alert.detail}</span>}
      </button>
      {(alert.project || alert.branch || alert.cwd) && <div className="alert-foot"><span className="truncate">{[alert.project, alert.branch].filter(Boolean).join(' / ')}</span>
        {alert.cwd && <OpenAction action="open-folder" target={alert.cwd} icon={FolderOpen}>打开目录</OpenAction>}</div>}
    </article>;
  })}</div>;
}
