import { useMemo } from 'react';
import { Crosshair, ExternalLink, FolderOpen, GitFork, GitPullRequest, ListTree, Pin, Radar, Terminal } from 'lucide-react';
import type { SubagentNode, TaskItem } from '@orrery/shared';
import { useNow } from '../../hooks/useNow';
import { formatClock, formatDuration, formatTokens, isActive, statusColorClass, statusLabel } from '../../lib/format';
import { EmptyState, Meter, OpenAction, SourceBadge, StatusBadge } from '../Telemetry';

const stepKinds = { tool_call: 'TOOL', command: 'CMD', reasoning: 'THINK', message: 'MSG', approval: 'GATE', subagent: 'AGENT', error: 'ERR' };
const stepTones = { running: 'tone-cyan', completed: 'tone-green', failed: 'tone-rose', waiting: 'tone-amber' };

function Topology({ nodes, drift }: { nodes: SubagentNode[]; drift: number }) {
  const children = useMemo(() => {
    const ids = new Set(nodes.map(node => node.id));
    const byParent = new Map<string | undefined, SubagentNode[]>();
    nodes.forEach(node => {
      const parent = node.parentId && ids.has(node.parentId) ? node.parentId : undefined;
      const siblings = byParent.get(parent) ?? [];
      siblings.push(node);
      byParent.set(parent, siblings);
    });
    return byParent;
  }, [nodes]);
  function branch(parent?: string) {
    const siblings = children.get(parent);
    return siblings && <ul className="tree-children">{siblings.map(node => <li key={node.id}>
      <div className="tree-node"><i className={`dot ${statusColorClass(node.status)}`} title={statusLabel(node.status)} />
        <strong>{node.title}</strong><small>{node.provider}</small><time>{formatDuration(node.durationMs + (isActive(node.status) ? drift : 0))}</time>
        {node.currentStep && <span className="tree-step">{node.currentStep}</span>}</div>
      {branch(node.id)}
    </li>)}</ul>;
  }
  return <div className="topology"><div className="tree-root"><GitFork size={13} />主任务</div>{branch()}</div>;
}

export function InspectorWidget({ task, pinned, onPin, onFollow, t3Url, generatedAt }: {
  task?: TaskItem; pinned: boolean; onPin: (id: string) => void; onFollow: () => void; t3Url?: string; generatedAt: string;
}) {
  const now = useNow();
  const steps = useMemo(() => task?.recentSteps.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)), [task?.recentSteps]);
  if (!task) return <EmptyState icon={Crosshair}>选择任务以查看执行详情</EmptyState>;
  const drift = Math.max(0, now - Date.parse(generatedAt));
  const tokens = task.tokens;
  const fields = [
    ['项目', task.project], ['模型 / 推理', [task.model || task.provider, task.reasoningEffort].filter(Boolean).join(' · ')],
    ['运行模式', task.runtimeMode], ['Git 分支', task.gitBranch], ['工作目录', task.cwd], ['Worktree', task.worktreePath], ['关联 PR', task.linkedPrUrl],
  ].filter((pair): pair is [string, string] => Boolean(pair[1]));
  const workspace = task.cwd || task.worktreePath;
  return <div className="widget-scroll padded inspector">
    <div className="between inspect-meta"><div className="inline-group"><StatusBadge status={task.status} /><SourceBadge source={task.source} /></div>
      <button className={`follow-button ${pinned ? 'pinned' : ''}`} aria-pressed={pinned} title={pinned ? '恢复跟随最新任务' : '固定此任务'} onClick={() => pinned ? onFollow() : onPin(task.id)}>
        {pinned ? <Pin size={12} /> : <Radar size={13} />}{pinned ? '已固定' : '跟随最新'}</button></div>
    <h3 className="inspect-title">{task.title}</h3>
    {task.errorMessage && <p className="error-snippet">{task.errorMessage}</p>}
    <dl className="inspector-fields">{fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd title={value}>{value}</dd></div>)}</dl>
    <div className="inspect-actions">
      {workspace && <OpenAction action="open-folder" target={workspace} icon={FolderOpen}>打开工作区</OpenAction>}
      {task.linkedPrUrl && <OpenAction action="open-url" target={task.linkedPrUrl} icon={GitPullRequest}>打开 PR</OpenAction>}
      {(task.source === 't3' || task.source === 't3-codex' || task.externalIds.t3ThreadId) && t3Url && <OpenAction action="open-url" target={t3Url} icon={ExternalLink}>打开 T3</OpenAction>}
    </div>
    <h4 className="section-label ruled">Token 用量{tokens && <span>{formatTokens(tokens.totalTokens)} tok</span>}</h4>
    {tokens ? <><dl className="token-breakdown">{[
      ['Input', tokens.inputTokens], ['Cached', tokens.cachedInputTokens], ['Output', tokens.outputTokens], ['Reasoning', tokens.reasoningTokens],
    ].map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{formatTokens(Number(value))}</dd></div>)}</dl>
      {tokens.contextPercent != null && <div className="context-line"><span>Context</span><Meter value={tokens.contextPercent} tone="tone-violet" /><b>{tokens.contextPercent.toFixed(1)}%</b>
        {tokens.contextWindow != null && <small>/ {formatTokens(tokens.contextWindow)}</small>}</div>}</> : <p className="muted">暂无 Token 采样</p>}
    <h4 className="section-label ruled"><ListTree size={14} />Subagent 拓扑<span>{task.subagents.length}</span></h4>
    {task.subagents.length ? <Topology nodes={task.subagents} drift={drift} /> : <p className="muted">此任务没有子代理</p>}
    <h4 className="section-label ruled"><Terminal size={14} />最近步骤<span>{steps?.length ?? 0}</span></h4>
    {steps?.length ? <ol className="step-chain">{steps.map(step => <li key={step.id}><i className={`dot ${stepTones[step.status]}`} title={step.status} />
      <time>{formatClock(step.startedAt)}</time><b>{stepKinds[step.kind]}</b>
      <span><strong>{step.label}</strong>{step.detail && <small>{step.detail}</small>}</span></li>)}</ol> : <p className="muted">暂无步骤记录</p>}
  </div>;
}
