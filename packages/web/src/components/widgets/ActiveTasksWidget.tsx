import { useMemo, useState } from 'react';
import { Clock3, GitBranch, GitFork, Layers3, Terminal } from 'lucide-react';
import type { TaskItem } from '@orrery/shared';
import { useNow } from '../../hooks/useNow';
import { formatDuration, formatTokens, isAbnormal, isActive, shortenPath, statusColorClass } from '../../lib/format';
import { EmptyState, Meter, SourceBadge, StatusBadge } from '../Telemetry';

const tabs = ['活跃', '全部', '已完成', '异常'] as const;
export function ActiveTasksWidget({ tasks, selectedId, onSelect, generatedAt }: {
  tasks: TaskItem[]; selectedId?: string; onSelect: (id: string) => void; generatedAt: string;
}) {
  const now = useNow();
  const [tab, setTab] = useState<typeof tabs[number]>('活跃');
  const groups = useMemo(() => ({
    活跃: tasks.filter(t => isActive(t.status) || t.status === 'queued'), 全部: tasks,
    已完成: tasks.filter(t => t.status === 'completed'), 异常: tasks.filter(t => isAbnormal(t.status) || t.isStale),
  }), [tasks]);
  return <div className="widget-column"><div className="widget-toolbar"><div className="segments" aria-label="任务状态">
    {tabs.map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}<span>{groups[t].length}</span></button>)}
  </div></div>
    {groups[tab].length ? <div className="widget-scroll card-list task-list">{groups[tab].map(task => {
      const context = task.tokens?.contextPercent;
      const elapsed = task.durationMs + (isActive(task.status) ? Math.max(0, now - Date.parse(generatedAt)) : 0);
      return <button className={`task-card ${statusColorClass(task.status)} ${task.id === selectedId ? 'selected' : ''}`} key={task.id}
        aria-pressed={task.id === selectedId} onClick={() => onSelect(task.id)}>
        <span className="task-status"><StatusBadge status={task.status} /><SourceBadge source={task.source} />
          {task.subagents.length > 0 && <span className="subagent-count" title="Subagents"><GitFork size={12} />{task.subagents.length}</span>}</span>
        <strong className="task-title">{task.title}</strong>
        <span className="task-location">{task.project || (task.cwd && shortenPath(task.cwd))}
          {task.gitBranch && <span><GitBranch size={12} />{task.gitBranch}</span>}
          {task.worktreePath && <span title={task.worktreePath}>{shortenPath(task.worktreePath)}</span>}</span>
        <span className="task-runtime"><span>{[task.model || task.provider, task.reasoningEffort].filter(Boolean).join(' · ')}</span>
          {task.currentStep && <span className="step-pill" title={task.currentStep}><Terminal size={11} /><span>{task.currentStep}</span></span>}</span>
        <span className="task-metrics"><span><Clock3 size={12} />{formatDuration(elapsed)}</span>
          {task.tokens && <span>{formatTokens(task.tokens.totalTokens)} tok</span>}
          {context != null && <span className="task-context"><Meter value={context} tone={context >= 90 ? 'tone-amber' : 'tone-violet'} />{context.toFixed(0)}% ctx</span>}</span>
      </button>;
    })}</div> : <EmptyState icon={Layers3}>当前视图没有任务</EmptyState>}
  </div>;
}
