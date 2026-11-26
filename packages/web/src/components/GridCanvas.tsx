import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { GridStack } from 'gridstack';
import { GripHorizontal, Plus, X } from 'lucide-react';
import { GRID_COLUMNS, GRID_ROWS, WIDGET_CATALOG } from '@orrery/shared';
import type { GridWidgetItem, LayoutPreset, WidgetType } from '@orrery/shared';
import { widgetIcons } from './Telemetry';

interface CanvasProps {
  preset: LayoutPreset;
  editing: boolean;
  badges: Record<WidgetType, string>;
  onChange: (items: GridWidgetItem[]) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  renderWidget: (type: WidgetType) => ReactNode;
}

export function GridCanvas(props: CanvasProps) {
  const { preset } = props;
  // React replaces the whole surface when membership changes. GridStack only owns geometry and handles.
  const membership = JSON.stringify([preset.id, ...preset.items.map(i => [i.id, i.type])]);
  return <GridSurface key={membership} {...props} />;
}

function GridSurface(props: CanvasProps) {
  const { preset, editing, badges, onRemove, onAdd, renderWidget } = props;
  const viewport = useRef<HTMLElement>(null);
  const element = useRef<HTMLDivElement>(null);
  const instance = useRef<GridStack | null>(null);
  const syncing = useRef(false);
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });

  useLayoutEffect(() => {
    const container = viewport.current!;
    const measuredHeight = () => Math.max(44, Math.floor((container.clientHeight - 12) / GRID_ROWS));
    const initial = latest.current;
    const grid = GridStack.init({
      auto: false, column: GRID_COLUMNS, maxRow: GRID_ROWS, float: true, margin: 5, animate: true,
      cellHeight: measuredHeight(), staticGrid: !initial.editing, handle: '.orrery-drag-handle',
      draggable: { scroll: false, cancel: 'button,input,select' }, resizable: { handles: 'se, s, e' },
    }, element.current!);
    instance.current = grid;
    grid.batchUpdate();
    grid.getGridItems().forEach((el, index) => {
      const item = initial.preset.items[index];
      const meta = WIDGET_CATALOG[item.type];
      grid.makeWidget(el, { ...item, minW: item.minW ?? meta.minW, minH: item.minH ?? meta.minH });
    });
    grid.batchUpdate(false);
    grid.on('change', (_event, nodes) => {
      if (!latest.current.editing || syncing.current) return;
      const positions = new Map(nodes.map(n => [n.id, n]));
      let moved = false;
      const items = latest.current.preset.items.map(item => {
        const node = positions.get(item.id);
        if (!node) return item;
        const { x = 0, y = 0, w = 1, h = 1 } = node;
        if (x === item.x && y === item.y && w === item.w && h === item.h) return item;
        moved = true;
        return { ...item, x, y, w, h };
      });
      if (moved) latest.current.onChange(items);
    });
    const observer = new ResizeObserver(() => grid.cellHeight(measuredHeight()));
    observer.observe(container);
    return () => {
      observer.disconnect();
      grid.destroy(false);
      instance.current = null;
    };
  }, []);

  useLayoutEffect(() => { instance.current?.setStatic(!editing); }, [editing]);
  useLayoutEffect(() => {
    const grid = instance.current;
    if (!grid) return;
    const positions = new Map(grid.engine.nodes.map(n => [n.id, n]));
    if (preset.items.every(i => {
      const n = positions.get(i.id);
      return n && i.x === n.x && i.y === n.y && i.w === n.w && i.h === n.h;
    })) return;
    syncing.current = true;
    grid.load(preset.items.map(i => ({ ...i })), false);
    syncing.current = false;
  }, [preset.items]);

  return <main className={`canvas-viewport ${editing ? 'editing' : ''}`} ref={viewport} aria-label="观测画布">
    <div ref={element} className="grid-stack">{preset.items.map(item => {
      const meta = WIDGET_CATALOG[item.type];
      const Icon = widgetIcons[item.type];
      return <section key={item.id} className="grid-stack-item" data-widget={item.type} tabIndex={-1} aria-label={item.title ?? meta.title}
        gs-id={item.id} gs-x={item.x} gs-y={item.y} gs-w={item.w} gs-h={item.h} gs-min-w={item.minW ?? meta.minW}
        gs-min-h={item.minH ?? meta.minH} gs-max-w={item.maxW} gs-max-h={item.maxH}>
        <div className="grid-stack-item-content widget-frame">
          <header className="widget-head orrery-drag-handle">
            {editing && <GripHorizontal size={13} className="grip" />}
            <Icon size={14} className="widget-icon" /><h2 title={meta.title}>{item.title || meta.shortTitle}</h2><span className="frame-badge">{badges[item.type]}</span>
            {editing && <button className="remove-widget" aria-label={'移除 ' + meta.shortTitle} title="移除组件" onClick={() => onRemove(item.id)}><X size={13} /></button>}
          </header>
          <div className="widget-body">{renderWidget(item.type)}</div>
        </div>
      </section>;
    })}</div>
    {!preset.items.length && <div className="empty-canvas"><span>画布为空</span>{editing && <button className="primary-button" onClick={onAdd}><Plus size={14} />添加组件</button>}</div>}
  </main>;
}
