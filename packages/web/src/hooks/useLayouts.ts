import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_PRESETS, GRID_COLUMNS, GRID_ROWS, WIDGET_CATALOG } from '@orrery/shared';
import type { GridWidgetItem, LayoutsPayload, WidgetType } from '@orrery/shared';
import { apiPath } from '../lib/api';
import { readLocal, writeLocal } from '../lib/storage';

const cacheKey = 'orrery.layouts.v1';

function isLayoutPayload(value: unknown): value is LayoutsPayload {
  if (!value || typeof value !== 'object' || !('presets' in value) || !Array.isArray(value.presets)
    || !('activePresetId' in value) || typeof value.activePresetId !== 'string') return false;
  return value.presets.some(p => p?.id === value.activePresetId) && value.presets.every(p =>
    typeof p?.id === 'string' && typeof p.name === 'string' && Array.isArray(p.items)
    && p.items.every((i: Partial<GridWidgetItem> | null) => i && typeof i.id === 'string'
      && i.type && Object.hasOwn(WIDGET_CATALOG, i.type) && [i.x, i.y, i.w, i.h].every(Number.isInteger)));
}

export function useLayouts() {
  const [payload, setPayload] = useState<LayoutsPayload>(() => {
    const cached = readLocal(cacheKey);
    return isLayoutPayload(cached) ? cached : { activePresetId: DEFAULT_PRESETS[0].id, presets: DEFAULT_PRESETS };
  });
  const current = useRef(payload);
  const pending = useRef('pendingSync' in payload && payload.pendingSync === true);
  const schedule = useRef<() => void>(() => {});

  const apply = useCallback((next: LayoutsPayload, dirty: boolean) => {
    current.current = next;
    pending.current = dirty;
    writeLocal(cacheKey, { ...next, pendingSync: dirty });
    setPayload(next);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    let writing = false;

    function later(delay: number) {
      window.clearTimeout(timer);
      timer = window.setTimeout(sync, delay);
    }

    async function sync() {
      if (writing || controller.signal.aborted) return;
      const start = current.current;
      const dirty = pending.current;
      writing = true;
      let retry = false;
      try {
        const response = await fetch(apiPath('layouts'), {
          method: dirty ? 'PUT' : 'GET',
          signal: controller.signal,
          cache: 'no-store',
          ...(dirty && {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activePresetId: start.activePresetId, presets: start.presets }),
          }),
        });
        if (!response.ok) throw new Error(String(response.status));
        const saved: unknown = await response.json();
        if (!isLayoutPayload(saved)) throw new Error('Invalid layouts');
        if (!controller.signal.aborted && start === current.current) apply(saved, false);
      } catch {
        retry = true;
      } finally {
        writing = false;
        if (!controller.signal.aborted) {
          if (start !== current.current && pending.current) later(350);
          else if (retry) later(5000);
        }
      }
    }

    schedule.current = () => later(350);
    void sync();
    window.addEventListener('online', sync);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener('online', sync);
    };
  }, [apply]);

  function change(next: LayoutsPayload) {
    apply(next, true);
    schedule.current();
  }

  const { presets, activePresetId } = payload;
  const activePreset = presets.find(p => p.id === activePresetId)!;

  function updateActiveItems(items: GridWidgetItem[]) {
    const edited = { ...activePreset, items, updatedAt: new Date().toISOString() };
    change({ activePresetId, presets: presets.map(p => p.id === activePresetId ? edited : p) });
  }

  function selectPreset(id: string) {
    if (id !== activePresetId && presets.some(p => p.id === id)) change({ activePresetId: id, presets });
  }

  function saveAsNewPreset(name: string) {
    const title = name.trim();
    if (!title) return;
    const preset = { ...activePreset, id: crypto.randomUUID(), name: title, builtIn: false, updatedAt: new Date().toISOString() };
    change({ activePresetId: preset.id, presets: [...presets, preset] });
  }

  function deletePreset(id: string) {
    if (!presets.some(p => p.id === id) || DEFAULT_PRESETS.some(p => p.id === id)) return;
    const remaining = presets.filter(p => p.id !== id);
    change({
      activePresetId: id === activePresetId ? (remaining[0] ?? DEFAULT_PRESETS[0]).id : activePresetId,
      presets: remaining.length ? remaining : DEFAULT_PRESETS,
    });
  }

  function resetActivePreset() {
    const original = DEFAULT_PRESETS.find(p => p.id === activePresetId) ?? DEFAULT_PRESETS[0];
    updateActiveItems(original.items);
  }

  function addWidget(type: WidgetType) {
    if (activePreset.items.some(i => i.type === type)) return '该组件已在画布中';
    const { defaultW, defaultH, minW, minH } = WIDGET_CATALOG[type];
    const sizes = Array.from({ length: defaultW - minW + 1 }, (_, dx) =>
      Array.from({ length: defaultH - minH + 1 }, (_, dy) => ({ w: defaultW - dx, h: defaultH - dy })))
      .flat().sort((a, b) => b.w * b.h - a.w * a.h);
    for (const { w, h } of sizes) {
      for (let y = 0; y <= GRID_ROWS - h; y++) {
        for (let x = 0; x <= GRID_COLUMNS - w; x++) {
          const fits = activePreset.items.every(i => x + w <= i.x || i.x + i.w <= x || y + h <= i.y || i.y + i.h <= y);
          if (fits) {
            updateActiveItems([...activePreset.items, { id: crypto.randomUUID(), type, x, y, w, h, minW, minH }]);
            return;
          }
        }
      }
    }
    return `「${WIDGET_CATALOG[type].shortTitle}」至少需要 ${minW} × ${minH} 格。请先缩小、移动或移除现有组件。`;
  }

  return {
    activePreset, presets, selectPreset, updateActiveItems, saveAsNewPreset, deletePreset, resetActivePreset, addWidget,
    removeWidget: (id: string) => updateActiveItems(activePreset.items.filter(i => i.id !== id)),
  };
}
