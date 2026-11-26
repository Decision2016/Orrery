import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Activity, BellRing, ChartNoAxesCombined, Check, Clock3, Cpu, Crosshair, Layers3, Radio, RadioTower, ScrollText, Waypoints, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SourceKind, TaskStatus, WidgetType } from '@orrery/shared';
import { percent, sourceNames, statusColorClass, statusLabel } from '../lib/format';
import { openTarget } from '../lib/api';

export const widgetIcons: Record<WidgetType, LucideIcon> = {
  agents: Cpu, 'quota-host': Activity, attention: BellRing, 'active-tasks': Layers3, timeline: ChartNoAxesCombined,
  inspector: Crosshair, 'queue-cron': Clock3, 'event-stream': Radio, 'token-chart': Waypoints,
};

export function SourceBadge({ source }: { source: SourceKind }) {
  return <span className={`source-badge source-${source}`}>{sourceNames[source]}</span>;
}

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-badge ${statusColorClass(status)}`}><i className={`dot ${status === 'running' ? 'pulse' : ''}`} />{statusLabel(status)}</span>;
}

export function Meter({ value, tone = 'tone-cyan' }: { value: number; tone?: string }) {
  return <span className={`meter ${tone}`} aria-hidden="true"><span style={{ width: `${percent(value)}%` }} /></span>;
}

export function Sparkline({ values, tone, label }: { values?: number[]; tone: string; label: string }) {
  const points = values?.filter(Number.isFinite);
  if (!points?.length) return <span className="spark-missing" title={label + ' · 暂无采样'}>—</span>;
  const low = Math.min(...points);
  const span = Math.max(1, Math.max(...points) - low);
  const coords = points.map((n, i) => [points.length === 1 ? 63 : 1 + i / (points.length - 1) * 62, 17 - (n - low) / span * 13]);
  return <svg viewBox="0 0 64 20" preserveAspectRatio="none" className={`sparkline ${tone}`} role="img" aria-label={label}>
    <path d="M0 18H64" className="spark-base" />
    <polyline points={coords.map(p => p.join(',')).join(' ')} fill="none" stroke="currentColor" vectorEffect="non-scaling-stroke" />
    <circle cx={coords.at(-1)![0]} cy={coords.at(-1)![1]} r="1.4" fill="currentColor" />
  </svg>;
}

export function EmptyState({ children, icon: Icon = RadioTower }: { children: ReactNode; icon?: LucideIcon }) {
  return <div className="empty-state"><Icon size={21} strokeWidth={1.4} /><span>{children}</span></div>;
}

export function OpenAction({ action, target, children, icon: Icon = ScrollText }: {
  action: 'open-folder' | 'open-url'; target: string; children: ReactNode; icon?: LucideIcon;
}) {
  const [state, setState] = useState('');
  useEffect(() => {
    if (!state || state === 'pending') return;
    const timer = window.setTimeout(() => setState(''), 3500);
    return () => window.clearTimeout(timer);
  }, [state]);
  return <span className="action-wrap">
    <button className="action-button" title={target} disabled={state === 'pending'} onClick={async () => {
      setState('pending');
      await openTarget(action, target).then(() => setState('ok'), e => setState(e instanceof Error ? e.message : '操作失败'));
    }}>{state === 'ok' ? <Check size={13} /> : <Icon size={13} />}{children}</button>
    {state && state !== 'pending' && state !== 'ok' && <small className="tone-rose" role="alert">{state}</small>}
  </span>;
}

export function Dialog({ title, onClose, children, className = '' }: {
  title: string; onClose: () => void; children: ReactNode; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className={`deck-dialog ${className}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === dialog.current) {
      const rect = dialog.current.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    } }}>
    <div className="dialog-head"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={16} /></button></div>
    {children}
  </dialog>;
}
