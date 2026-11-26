import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Check, ChevronDown, CircleAlert, CopyPlus, Expand, EyeOff, GitFork, Hash, Hourglass, LayoutGrid, ListOrdered, LockKeyhole, Minimize, Moon, PencilRuler, Play, Plus, Power, RotateCcw, Search, Sun, Trash2, Type, X } from 'lucide-react';
import type { SnapshotSummary } from '@orrery/shared';
import type { ConnectionState } from '../hooks/useOrreryStream';
import type { useLayouts } from '../hooks/useLayouts';
import { useNow } from '../hooks/useNow';
import { hideDesktopWindow, quitOrreryProcess } from '../lib/api';
import { formatClock, formatTokens } from '../lib/format';
import { Dialog } from './Telemetry';

export type SourceFilter = 'all' | 't3' | 'codex' | 'merged';
export type TextScale = 'normal' | 'large' | 'xlarge';
export type Theme = 'dark' | 'light';
const scaleLabels: Record<TextScale, string> = {
  normal: '标准字号',
  large: '14.1" 大字',
  xlarge: '远距超大',
};
const scaleOrder: TextScale[] = ['normal', 'large', 'xlarge'];
const filters = [
  ['all', 'ALL', '所有来源'], ['t3', 'T3 Code', '含 T3 → Codex'], ['codex', 'Codex', 'Codex App、CLI 与 T3 → Codex'], ['merged', 'Merged', '仅跨来源合并的任务'],
] as const;

function SignalClock({ connection }: { connection: ConnectionState }) {
  const now = useNow();
  const label = { connected: 'LIVE', reconnecting: 'SYNC', offline: 'OFFLINE' }[connection];
  return <div className="signal-clock"><span className={`signal signal-${connection}`} title={`SSE · ${label}`} aria-label={`SSE ${connection}`}>
    <i className={`dot ${connection === 'connected' ? 'pulse' : ''}`} /><span>{label}</span>
  </span><time>{formatClock(now)}</time></div>;
}

interface HudProps {
  summary?: SnapshotSummary;
  connection: ConnectionState;
  layouts: ReturnType<typeof useLayouts>;
  filter: SourceFilter;
  onFilter: (value: SourceFilter) => void;
  query: string;
  onQuery: (value: string) => void;
  editing: boolean;
  onEdit: () => void;
  onDrawer: () => void;
  notifications: boolean;
  onNotifications: () => void;
  textScale: TextScale;
  onTextScale: (value: TextScale) => void;
  theme: Theme;
  onToggleTheme: () => void;
  onNotice: (message: string) => void;
}

export function HudBar({ summary, connection, layouts, filter, onFilter, query, onQuery, editing, onEdit, onDrawer, notifications, onNotifications, textScale, onTextScale, theme, onToggleTheme, onNotice }: HudProps) {
  const themeAction = theme === 'dark' ? '切换浅色模式' : '切换深色模式';
  const search = useRef<HTMLInputElement>(null);
  const [modal, setModal] = useState<'save' | 'delete' | 'quit' | null>(null);
  const [quitting, setQuitting] = useState(false);
  const [name, setName] = useState('');
  const isDesktop = Boolean(window.__TAURI_INTERNALS__);
  const [fullscreen, setFullscreen] = useState(Boolean(document.fullscreenElement));
  useEffect(() => {
    const resize = () => setFullscreen(Boolean(document.fullscreenElement));
    const shortcut = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector('dialog[open]')
        && !(e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.closest('input, textarea, select')))) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    document.addEventListener('fullscreenchange', resize);
    window.addEventListener('keydown', shortcut);
    return () => { document.removeEventListener('fullscreenchange', resize); window.removeEventListener('keydown', shortcut); };
  }, []);
  const kpis = [
    { label: 'Running', value: summary?.runningCount, icon: Play, tone: 'tone-cyan' },
    { label: 'Waiting', value: summary?.waitingCount, icon: Hourglass, tone: 'tone-amber' },
    { label: 'Queued', value: summary?.queuedCount, icon: ListOrdered, tone: 'tone-blue' },
    { label: 'Err 24h', value: summary?.failed24hCount, icon: CircleAlert, tone: 'tone-rose' },
    { label: 'Today Tokens', value: summary && formatTokens(summary.todayTokens), icon: Hash, tone: 'tone-violet' },
    { label: 'Subagents', value: summary?.activeSubagents, icon: GitFork, tone: 'tone-green' },
  ];
  return <header className="hud">
    <div className="wordmark" aria-label="Orrery">
      <svg viewBox="0 0 40 34" width="39" height="34" aria-hidden="true">
        <circle cx="20" cy="17" r="10.8" fill="none" stroke="var(--cyan)" strokeWidth="1.3" />
        <ellipse cx="20" cy="17" rx="18.3" ry="6.5" transform="rotate(-29 20 17)" fill="none" stroke="var(--brand-orbit)" strokeWidth="1.35" />
        <circle cx="20" cy="17" r="2.7" fill="var(--brand-orbit)" /><circle cx="34.4" cy="7.4" r="2" fill="var(--cyan)" />
      </svg><b>ORRERY</b>
    </div>
    <div className="hud-kpis" aria-label="全局指标">{kpis.map(({ label, value, icon: Icon, tone }) =>
      <span className="hud-kpi" key={label} title={`${label} · ${value ?? '—'}`}>
        <Icon size={12} className={tone} /><span className="kpi-label">{label}</span><strong>{value ?? '—'}</strong>
      </span>)}</div>
    <div className="hud-query">
      <div className="filter-group" aria-label="来源筛选">{filters.map(([id, label, hint]) =>
        <button key={id} className={filter === id ? 'chosen' : ''} aria-pressed={filter === id} title={hint} onClick={() => onFilter(id)}>{label}</button>)}</div>
      <label className="search-box"><Search size={14} /><input ref={search} type="search" value={query} aria-label="搜索任务与事件" placeholder="搜索任务与事件" onChange={e => onQuery(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { onQuery(''); search.current?.blur(); } }} />
        {query ? <button aria-label="清空搜索" onClick={() => { onQuery(''); search.current?.focus(); }}><X size={12} /></button> : <kbd>/</kbd>}
      </label>
    </div>
    <div className="hud-controls">
      <label className="preset-select" title={layouts.activePreset.name}><LayoutGrid size={14} />
        <select aria-label="布局预设" value={layouts.activePreset.id} onChange={e => layouts.selectPreset(e.target.value)}>
          {layouts.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select><ChevronDown size={12} /></label>
      <button className={`hud-button ${editing ? 'is-editing' : ''}`} aria-label={editing ? '锁定布局' : '编辑布局'} aria-pressed={editing} onClick={onEdit} title={editing ? '锁定布局' : '编辑布局'}>
        {editing ? <LockKeyhole size={14} /> : <PencilRuler size={14} />}<span>{editing ? '锁定布局' : '编辑布局'}</span>
      </button>
      {editing && <>
        <button className="hud-button add-button" onClick={onDrawer} aria-label="添加组件" title="添加组件"><Plus size={14} /><span>添加组件</span></button>
        <button className="hud-button" onClick={layouts.resetActivePreset} aria-label="重置" title={layouts.activePreset.builtIn ? '恢复此预设的初始布局' : '恢复全景组件布局'}><RotateCcw size={14} /><span>重置</span></button>
        <button className="hud-button" onClick={() => { setName(''); setModal('save'); }} aria-label="另存预设" title="另存预设"><CopyPlus size={14} /><span>另存预设</span></button>
        {!layouts.activePreset.builtIn && <button className="icon-button" onClick={() => setModal('delete')} aria-label="删除预设" title="删除预设"><Trash2 size={14} /></button>}
      </>}
      <button className={`hud-button ${textScale !== 'normal' ? 'is-editing' : ''}`} onClick={() => {
        const next = scaleOrder[(scaleOrder.indexOf(textScale) + 1) % scaleOrder.length];
        onTextScale(next);
        onNotice(`字号已切换为「${scaleLabels[next]}」`);
      }} aria-label="切换字号大小" title={`当前：${scaleLabels[textScale]}（点击循环切换标准 / 14.1" 大字 / 远距超大）`}>
        <Type size={14} /><span>{scaleLabels[textScale]}</span>
      </button>
      <button className="icon-button" aria-label={themeAction} title={themeAction} onClick={onToggleTheme}>
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
      <button className={`icon-button ${notifications ? 'tone-cyan' : ''}`} onClick={onNotifications} aria-label="桌面通知" title={notifications ? '关闭桌面通知' : '启用桌面通知'} aria-pressed={notifications}>
        {notifications ? <Bell size={15} /> : <BellOff size={15} />}</button>
      <button className="icon-button" aria-label={fullscreen ? '退出全屏' : '进入全屏'} title={fullscreen ? '退出全屏' : '进入全屏'} onClick={async () => {
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
        catch { onNotice('此窗口无法切换全屏'); }
      }}>{fullscreen ? <Minimize size={15} /> : <Expand size={15} />}</button>
      <button className="icon-button tone-rose" aria-label="关闭进程" title="关闭 Orrery 进程或隐藏到托盘" onClick={() => setModal('quit')}>
        <Power size={15} />
      </button>
    </div>
    <SignalClock connection={connection} />
    {modal && <Dialog title={modal === 'save' ? '另存布局预设' : modal === 'delete' ? '删除布局预设' : '关闭 Orrery 进程'} onClose={() => { if (!quitting) setModal(null); }}>
      {modal === 'save' ? <form className="dialog-form" onSubmit={e => { e.preventDefault(); if (name.trim()) { layouts.saveAsNewPreset(name); setModal(null); } }}>
        <label>预设名称<input autoFocus required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="输入预设名称" /></label>
        <button className="primary-button" disabled={!name.trim()}><Check size={14} />保存预设</button>
      </form> : modal === 'delete' ? <div className="dialog-form"><p>删除「{layouts.activePreset.name}」？</p><button className="action-button tone-rose" onClick={() => { layouts.deletePreset(layouts.activePreset.id); setModal(null); }}>删除预设</button></div>
      : <div className="dialog-form">
        <p className="muted">选择隐藏窗口到系统托盘，或彻底关闭 Orrery 及后台采集服务进程。</p>
        <div className="action-wrap">
          {isDesktop && <button className="action-button" disabled={quitting} onClick={async () => {
            try { await hideDesktopWindow(); setModal(null); }
            catch (error) { onNotice(error instanceof Error ? error.message : '隐藏窗口失败'); }
          }}><EyeOff size={14} />隐藏到托盘</button>}
          <button className="action-button tone-rose" disabled={quitting} onClick={async () => {
            setQuitting(true);
            try { await quitOrreryProcess(); }
            catch (error) { setQuitting(false); setModal(null); onNotice(error instanceof Error ? error.message : '关闭进程失败'); }
          }}><Power size={14} />{quitting ? '正在关闭…' : '彻底关闭进程'}</button>
        </div>
      </div>}
    </Dialog>}
  </header>;
}
