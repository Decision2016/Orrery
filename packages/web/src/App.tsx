import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { SourceKind, TaskItem, WidgetType } from '@orrery/shared';
import { useLayouts } from './hooks/useLayouts';
import { useOrreryStream } from './hooks/useOrreryStream';
import { apiPath, requestAlerts } from './lib/api';
import { isActive, sourceNames } from './lib/format';
import { readLocal, writeLocal } from './lib/storage';
import { GridCanvas } from './components/GridCanvas';
import { HudBar } from './components/HudBar';
import type { SourceFilter } from './components/HudBar';
import { Dialog, EmptyState, widgetIcons } from './components/Telemetry';
import { WidgetDrawer } from './components/WidgetDrawer';
import { AgentsWidget } from './components/widgets/AgentsWidget';
import { QuotaHostWidget } from './components/widgets/QuotaHostWidget';
import { AttentionWidget } from './components/widgets/AttentionWidget';
import { ActiveTasksWidget } from './components/widgets/ActiveTasksWidget';
import { TimelineWidget } from './components/widgets/TimelineWidget';
import { InspectorWidget } from './components/widgets/InspectorWidget';
import { QueueCronWidget } from './components/widgets/QueueCronWidget';
import { EventStreamWidget } from './components/widgets/EventStreamWidget';
import { TokenChartWidget } from './components/widgets/TokenChartWidget';

export default function App() {
  const layouts = useLayouts();
  const [editing, setEditing] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>('all');
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query.trim().toLowerCase());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskItem | null>(null);
  const [inspectDialog, setInspectDialog] = useState(false);
  const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState(() => readLocal('orrery.notifications') === true
    && (('Notification' in window && Notification.permission === 'granted') || Boolean(window.__TAURI_INTERNALS__)));
  const hasInspector = layouts.activePreset.items.some(i => i.type === 'inspector');
  const selectTask = useCallback((id: string) => {
    setSelectedId(id);
    if (!hasInspector) setInspectDialog(true);
    else document.querySelector<HTMLElement>('[data-widget="inspector"]')?.focus({ preventScroll: true });
  }, [hasInspector]);
  const { snapshot, connection } = useOrreryStream(notifications, selectTask);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const byId = useMemo(() => new Map(snapshot?.tasks.map(t => [t.id, t])), [snapshot?.tasks]);
  const localTask = selectedId ? byId.get(selectedId) : undefined;
  useEffect(() => {
    if (!selectedId || localTask) return;
    const controller = new AbortController();
    void fetch(apiPath('tasks/' + encodeURIComponent(selectedId)), { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<TaskItem>;
      }).then(task => { if (!controller.signal.aborted) setDetail(task); })
      .catch(() => { if (!controller.signal.aborted) { setSelectedId(null); setNotice('关联任务详情暂不可用'); } });
    return () => controller.abort();
  }, [selectedId, localTask]);

  const view = useMemo(() => {
    const matchesSource = (s: SourceKind) => filter === 'all' || (filter === 't3' && (s === 't3' || s === 't3-codex'))
      || (filter === 'codex' && (s === 'codex-app' || s === 'codex-cli' || s === 't3-codex')) || (filter === 'merged' && s === 't3-codex');
    const contains = (...parts: (string | undefined)[]) => !search || parts.some(p => p?.toLowerCase().includes(search));
    const tasks = (snapshot?.tasks ?? []).filter(t => matchesSource(t.source)
      && contains(t.title, t.project, t.gitBranch, t.worktreePath, t.cwd, t.model, t.currentStep, t.id, t.sourceLabel))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const matchingIds = new Set(tasks.map(t => t.id));
    const related = (s: SourceKind, id?: string) => matchesSource(s) || Boolean(id && byId.has(id) && matchesSource(byId.get(id)!.source));
    const alerts = (snapshot?.alerts ?? []).filter(a => related(a.source, a.taskId) && (matchingIds.has(a.taskId) || contains(a.title, a.detail, a.project, a.branch)));
    const timeline = (snapshot?.timeline ?? []).filter(t => related(t.source, t.taskId) && (matchingIds.has(t.taskId) || contains(t.label, t.project, t.provider)));
    const events = (snapshot?.events ?? []).filter(e => related(e.source, e.taskId) && ((e.taskId && matchingIds.has(e.taskId)) || contains(e.summary, e.taskTitle, e.detail, sourceNames[e.source])))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const scheduled = (snapshot?.scheduled ?? []).filter(s => (filter === 'all' || filter === s.source) && contains(s.title, s.scheduleText, s.model, s.cwd));
    return { tasks, alerts, timeline, events, scheduled };
  }, [snapshot, byId, filter, search]);

  const selected = selectedId ? localTask ?? (detail?.id === selectedId ? detail : undefined) : view.tasks.find(t => isActive(t.status)) ?? view.tasks[0];
  const inspector = <InspectorWidget key={selected?.id} task={selected} pinned={Boolean(selectedId)} onPin={selectTask} onFollow={() => setSelectedId(null)}
    generatedAt={snapshot?.generatedAt ?? ''} t3Url={snapshot?.agents.find(a => /t3/i.test(a.id + ' ' + a.name) && a.endpointUrl)?.endpointUrl} />;
  const count = (n: number) => snapshot ? String(n).padStart(2, '0') : '—';
  const badges: Record<WidgetType, string> = {
    agents: snapshot ? `${snapshot.agents.filter(a => a.status === 'online').length}/${snapshot.agents.length} ONLINE` : '—',
    'quota-host': snapshot ? `${snapshot.quotas.length} WINDOWS` : '—',
    attention: count(view.alerts.length), 'active-tasks': count(view.tasks.length), timeline: count(view.timeline.length),
    inspector: selected ? (selectedId ? 'PINNED' : 'AUTO') : '—', 'queue-cron': count(view.scheduled.length), 'event-stream': count(view.events.length),
    'token-chart': snapshot ? `${snapshot.tokenHistory.length} SAMPLES` : '—',
  };
  function renderWidget(type: WidgetType) {
    if (!snapshot) return <EmptyState icon={widgetIcons[type]}>{connection === 'offline' ? '本地观测服务离线' : '等待遥测快照'}</EmptyState>;
    switch (type) {
      case 'agents': return <AgentsWidget agents={snapshot.agents} />;
      case 'quota-host': return <QuotaHostWidget quotas={snapshot.quotas} host={snapshot.host} />;
      case 'attention': return <AttentionWidget alerts={view.alerts} total={snapshot.alerts.length} onSelect={selectTask} connected={connection === 'connected'} />;
      case 'active-tasks': return <ActiveTasksWidget tasks={view.tasks} selectedId={selected?.id} onSelect={selectTask} generatedAt={snapshot.generatedAt} />;
      case 'timeline': return <TimelineWidget segments={view.timeline} selectedId={selected?.id} onSelect={selectTask} />;
      case 'inspector': return inspector;
      case 'queue-cron': return <QueueCronWidget scheduled={view.scheduled} />;
      case 'event-stream': return <EventStreamWidget events={view.events} onSelect={selectTask} />;
      case 'token-chart': return <TokenChartWidget history={snapshot.tokenHistory} />;
    }
  }

  return <div className="orrery-deck h-screen w-screen flex flex-col overflow-hidden">
    <HudBar summary={snapshot?.summary} connection={connection} layouts={layouts} filter={filter} onFilter={setFilter} query={query} onQuery={setQuery}
      editing={editing} onEdit={() => { setEditing(!editing); setDrawer(false); }} onDrawer={() => setDrawer(true)} notifications={notifications}
      onNotifications={async () => {
        const enabled = !notifications && await requestAlerts().catch(() => false);
        if (!notifications && !enabled) setNotice('桌面通知未获授权，可在系统或浏览器设置中启用');
        setNotifications(enabled);
        writeLocal('orrery.notifications', enabled);
      }} onNotice={setNotice} />
    <GridCanvas preset={layouts.activePreset} editing={editing} onChange={layouts.updateActiveItems} onRemove={layouts.removeWidget}
      badges={badges} renderWidget={renderWidget} onAdd={() => setDrawer(true)} />
    {editing && drawer && <WidgetDrawer items={layouts.activePreset.items} addWidget={layouts.addWidget} onClose={() => setDrawer(false)} />}
    {inspectDialog && !hasInspector && <Dialog title="焦点任务" className="inspect-dialog" onClose={() => setInspectDialog(false)}>{inspector}</Dialog>}
    {notice && <div className="deck-notice" role="status">{notice}</div>}
  </div>;
}
