import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, Palette, RefreshCw } from 'lucide-react';
import { CORE_TOKEN_PROVIDERS, type DailyTokenPoint, type TokenActivityPayload, type TokenProviderMeta } from '@orrery/shared';
import { syncTokenActivity } from '../../lib/api';
import { formatTokens } from '../../lib/format';
import { readLocal, writeLocal } from '../../lib/storage';

type ActivityMode = 'daily' | 'weekly' | 'cumulative';
type ColorPresetId = 'auto' | 'blue' | 'emerald' | 'violet' | 'amber' | 'cyan' | 'rose' | 'custom';

const WEEK_COLS = 53;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const COLOR_PRESETS: readonly { id: Exclude<ColorPresetId, 'custom'>; label: string; swatch: string }[] = [
  { id: 'auto', label: '跟随 Provider', swatch: 'linear-gradient(135deg, #0077ff 0 50%, #7c6bf2 50% 100%)' },
  { id: 'blue', label: 'Codex 蓝', swatch: '#0077ff' },
  { id: 'emerald', label: 'GitHub 绿', swatch: '#10b981' },
  { id: 'violet', label: '星云紫', swatch: '#7c6bf2' },
  { id: 'amber', label: '暖珀橙', swatch: '#e07a2b' },
  { id: 'cyan', label: '极光青', swatch: '#06b6d4' },
  { id: 'rose', label: '珊瑚红', swatch: '#f43f5e' },
];

interface CellDatum {
  date: string;
  col: number;
  row: number;
  total: number;
  input: number;
  cached: number;
  output: number;
  calls: number;
  byProvider: DailyTokenPoint['byProvider'];
  future: boolean;
}

function toLocalDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function autoRampForProvider(provider: string): Exclude<ColorPresetId, 'auto' | 'custom'> {
  if (provider === 'gemini') return 'violet';
  if (provider === 'claude') return 'amber';
  if (provider === 'deepseek' || provider === 'opencode') return 'cyan';
  return 'blue';
}

function validHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function computeThresholds(values: number[]): [number, number, number] {
  const nonZero = values.filter(v => v > 0).sort((a, b) => a - b);
  if (!nonZero.length) return [1, 10, 100];
  const pick = (q: number) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * q))];
  const t1 = Math.max(1, pick(0.42));
  const t2 = Math.max(t1 + 1, pick(0.74));
  const t3 = Math.max(t2 + 1, pick(0.91));
  return [t1, t2, t3];
}

function levelOf(value: number, [t1, t2, t3]: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0) return 0;
  if (value < t1) return 1;
  if (value < t2) return 2;
  if (value < t3) return 3;
  return 4;
}

export function TokenActivityWidget({
  activity,
  onNotice,
}: {
  activity?: TokenActivityPayload;
  onNotice: (msg: string) => void;
}) {
  const [provider, setProvider] = useState<string>(() => {
    const saved = readLocal('orrery.tokenActivity.provider');
    return typeof saved === 'string' && saved ? saved : 'all';
  });
  const [mode, setMode] = useState<ActivityMode>(() => {
    const saved = readLocal('orrery.tokenActivity.mode');
    return saved === 'weekly' || saved === 'cumulative' ? saved : 'daily';
  });
  const [colorPreset, setColorPreset] = useState<ColorPresetId>(() => {
    const saved = readLocal('orrery.tokenActivity.colorPreset');
    return saved === 'auto' || saved === 'blue' || saved === 'emerald' || saved === 'violet' || saved === 'amber' || saved === 'cyan' || saved === 'rose' || saved === 'custom'
      ? saved
      : 'blue';
  });
  const [customColor, setCustomColor] = useState<string>(() => {
    const saved = readLocal('orrery.tokenActivity.customColor');
    return validHexColor(saved) ? saved : '#0077ff';
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [hovered, setHovered] = useState<{ title: string; subtitle: string; detail?: string } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const colorRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 680, h: 150 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) {
        setBox({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen && !colorOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuOpen && menuRef.current && !menuRef.current.contains(target)) {
        setMenuOpen(false);
      }
      if (colorOpen && colorRef.current && !colorRef.current.contains(target)) {
        setColorOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen, colorOpen]);

  const providers: TokenProviderMeta[] = useMemo(() => {
    if (activity?.providers?.length) return activity.providers;
    return CORE_TOKEN_PROVIDERS.map(p => ({ ...p, totalTokens: 0, todayTokens: 0, activeDays: 0 }));
  }, [activity?.providers]);

  const effectiveProvider = provider === 'all' || providers.some(p => p.id === provider) ? provider : 'all';

  const { cells, weeks, cumulative, monthLabels, rangeTotal, todayTotal, activeDays } = useMemo(() => {
    const byDate = new Map<string, DailyTokenPoint>();
    for (const d of activity?.days ?? []) byDate.set(d.date, d);

    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayDow = todayMidnight.getDay(); // 0=Sun .. 6=Sat
    const endOfGrid = new Date(todayMidnight);
    endOfGrid.setDate(todayMidnight.getDate() + (6 - todayDow));
    const startOfGrid = new Date(endOfGrid);
    startOfGrid.setDate(endOfGrid.getDate() - (WEEK_COLS * 7 - 1));

    const gridCells: CellDatum[] = [];
    const weekSums: { startDate: string; endDate: string; total: number; calls: number }[] = [];
    const cumPoints: { date: string; col: number; daily: number; cumulative: number }[] = [];
    const months: { col: number; label: string }[] = [];

    let runningTotal = 0;
    let openActiveDays = 0;
    let todayTok = 0;
    const todayKey = toLocalDateKey(todayMidnight);
    let prevMonth = -1;

    for (let col = 0; col < WEEK_COLS; col++) {
      let weekTotal = 0;
      let weekCalls = 0;
      let weekStart = '';
      let weekEnd = '';

      for (let row = 0; row < 7; row++) {
        const cur = new Date(startOfGrid);
        cur.setDate(startOfGrid.getDate() + col * 7 + row);
        const key = toLocalDateKey(cur);
        const future = cur.getTime() > todayMidnight.getTime();
        if (row === 0) weekStart = key;
        if (!future) weekEnd = key;

        if (cur.getDate() <= 7 && cur.getMonth() !== prevMonth && row === 0) {
          months.push({ col, label: `${cur.getMonth() + 1}月` });
          prevMonth = cur.getMonth();
        } else if (col === 0 && row === 0) {
          months.push({ col: 0, label: `${cur.getMonth() + 1}月` });
          prevMonth = cur.getMonth();
        }

        const dayPoint = byDate.get(key);
        let total = 0;
        let input = 0;
        let cached = 0;
        let output = 0;
        let calls = 0;
        if (dayPoint && !future) {
          if (effectiveProvider === 'all') {
            total = dayPoint.totalTokens;
            input = dayPoint.inputTokens;
            cached = dayPoint.cachedTokens;
            output = dayPoint.outputTokens;
            calls = dayPoint.calls;
          } else {
            const sub = dayPoint.byProvider[effectiveProvider];
            if (sub) {
              total = sub.totalTokens;
              input = sub.inputTokens;
              cached = sub.cachedTokens;
              output = sub.outputTokens;
              calls = sub.calls;
            }
          }
        }
        if (!future) {
          runningTotal += total;
          weekTotal += total;
          weekCalls += calls;
          if (total > 0) openActiveDays++;
          if (key === todayKey) todayTok = total;
          cumPoints.push({ date: key, col, daily: total, cumulative: runningTotal });
        }

        gridCells.push({
          date: key,
          col,
          row,
          total,
          input,
          cached,
          output,
          calls,
          byProvider: dayPoint?.byProvider ?? {},
          future,
        });
      }
      weekSums.push({ startDate: weekStart, endDate: weekEnd || weekStart, total: weekTotal, calls: weekCalls });
    }

    const cleanMonths = months.filter((m, idx) => idx > 0 || !months[1] || months[1].col - m.col >= 3);

    return {
      cells: gridCells,
      weeks: weekSums,
      cumulative: cumPoints,
      monthLabels: cleanMonths,
      rangeTotal: runningTotal,
      todayTotal: todayTok,
      activeDays: openActiveDays,
    };
  }, [activity?.days, effectiveProvider]);

  const dailyThresholds = useMemo(() => computeThresholds(cells.filter(c => !c.future).map(c => c.total)), [cells]);
  const weeklyThresholds = useMemo(() => computeThresholds(weeks.map(w => w.total)), [weeks]);

  const allTotalTokens = useMemo(() => providers.reduce((sum, p) => sum + p.totalTokens, 0), [providers]);
  const selectedMeta = effectiveProvider === 'all' ? undefined : providers.find(p => p.id === effectiveProvider);
  const resolvedRamp = colorPreset === 'auto' ? autoRampForProvider(effectiveProvider) : colorPreset;
  const widgetStyle = resolvedRamp === 'custom'
    ? ({ '--activity-custom': customColor } as CSSProperties)
    : undefined;

  async function handleSync() {
    setSyncing(true);
    try {
      const updated = await syncTokenActivity(false);
      onNotice(`已同步各 Provider 本地 Token 数据（共 ${updated.days.length} 个活跃日期）`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  }

  const labelBandH = 18;
  const padX = 4;
  const padTop = 4;
  const availW = Math.max(200, box.w - padX * 2);
  const availH = Math.max(64, box.h - labelBandH - padTop);
  const gap = availW >= 620 && availH >= 110 ? 3 : 2;
  const cellSize = Math.max(5, Math.min(Math.floor((availW - (WEEK_COLS - 1) * gap) / WEEK_COLS), Math.floor((availH - 6 * gap) / 7)));
  const gridW = WEEK_COLS * cellSize + (WEEK_COLS - 1) * gap;
  const gridH = 7 * cellSize + 6 * gap;
  const offsetX = Math.max(padX, Math.floor((box.w - gridW) / 2));
  const offsetY = Math.max(padTop, Math.floor((availH - gridH) / 2));
  const rx = Math.max(2, +(cellSize * 0.32).toFixed(1));

  const maxWeek = Math.max(1, ...weeks.map(w => w.total));
  const maxCum = Math.max(1, cumulative.at(-1)?.cumulative ?? 0);

  return (
    <div className="widget-column token-activity-widget" data-ramp={resolvedRamp} style={widgetStyle}>
      <div className="widget-toolbar token-activity-toolbar">
        <div className="token-activity-summary">
          {hovered ? (
            <>
              <strong className="mono">{hovered.title}</strong>
              <span className="token-activity-hover-sub">{hovered.subtitle}</span>
              {hovered.detail && <small className="muted">{hovered.detail}</small>}
            </>
          ) : (
            <>
              <strong className="token-activity-heading">Token 活动</strong>
              <span className="token-activity-kpi mono">
                累计 <b>{formatTokens(rangeTotal)}</b>
              </span>
              <span className="token-activity-kpi mono">
                今日 <b>{formatTokens(todayTotal)}</b>
              </span>
              <small className="muted">{activeDays} 活跃天</small>
            </>
          )}
        </div>

        <div className="token-activity-controls">
          <div className="provider-dropdown" ref={menuRef}>
            <button
              type="button"
              className="provider-select-btn"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              onClick={() => { setMenuOpen(open => !open); setColorOpen(false); }}
              title="选择要显示的模型 Provider"
            >
              <i className={`dot provider-dot-${effectiveProvider}`} />
              <span>{selectedMeta ? selectedMeta.name : '全部 Provider'}</span>
              <ChevronDown size={13} />
            </button>
            {menuOpen && (
              <div className="provider-menu" role="listbox" aria-label="选择 Provider">
                <button
                  type="button"
                  role="option"
                  aria-selected={effectiveProvider === 'all'}
                  className={`provider-option ${effectiveProvider === 'all' ? 'is-selected' : ''}`}
                  onClick={() => {
                    setProvider('all');
                    writeLocal('orrery.tokenActivity.provider', 'all');
                    setMenuOpen(false);
                  }}
                >
                  <span className="inline-group">
                    <i className="dot provider-dot-all" />
                    全部 Provider
                  </span>
                  <span className="mono muted">{formatTokens(allTotalTokens)}</span>
                  {effectiveProvider === 'all' && <Check size={12} />}
                </button>
                {providers.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={effectiveProvider === item.id}
                    className={`provider-option ${effectiveProvider === item.id ? 'is-selected' : ''}`}
                    onClick={() => {
                      setProvider(item.id);
                      writeLocal('orrery.tokenActivity.provider', item.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="inline-group">
                      <i className={`dot provider-dot-${item.id}`} />
                      {item.name}
                    </span>
                    <span className="mono muted">{formatTokens(item.totalTokens)}</span>
                    {effectiveProvider === item.id && <Check size={12} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="provider-dropdown" ref={colorRef}>
            <button
              type="button"
              className="provider-select-btn activity-color-btn"
              aria-expanded={colorOpen}
              onClick={() => { setColorOpen(open => !open); setMenuOpen(false); }}
              title="设置热力图配色与自定义颜色"
            >
              <span className="activity-color-chip" />
              <Palette size={13} />
            </button>
            {colorOpen && (
              <div className="provider-menu activity-color-menu" role="dialog" aria-label="设置图表颜色">
                <div className="activity-color-grid">
                  {COLOR_PRESETS.map(preset => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`activity-swatch-option ${colorPreset === preset.id ? 'is-selected' : ''}`}
                      onClick={() => {
                        setColorPreset(preset.id);
                        writeLocal('orrery.tokenActivity.colorPreset', preset.id);
                      }}
                    >
                      <i className="activity-swatch-dot" style={{ background: preset.swatch }} />
                      <span>{preset.label}</span>
                      {colorPreset === preset.id && <Check size={12} />}
                    </button>
                  ))}
                </div>
                <div className="activity-custom-row">
                  <label className="activity-custom-picker">
                    <input
                      type="color"
                      value={customColor}
                      onChange={e => {
                        const hex = e.target.value;
                        setCustomColor(hex);
                        setColorPreset('custom');
                        writeLocal('orrery.tokenActivity.customColor', hex);
                        writeLocal('orrery.tokenActivity.colorPreset', 'custom');
                      }}
                    />
                    <span>自定义颜色</span>
                  </label>
                  <span className="mono muted">{customColor.toUpperCase()}</span>
                </div>
                <div className="activity-ramp-preview" aria-hidden="true">
                  <span className="muted">少</span>
                  <i className="lv-chip lv-0" />
                  <i className="lv-chip lv-1" />
                  <i className="lv-chip lv-2" />
                  <i className="lv-chip lv-3" />
                  <i className="lv-chip lv-4" />
                  <span className="muted">多</span>
                </div>
              </div>
            )}
          </div>

          <div className="segments activity-mode-tabs" role="group" aria-label="统计维度">
            {([
              ['daily', '每天'],
              ['weekly', '每周'],
              ['cumulative', '累计总量'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={mode === key}
                onClick={() => {
                  setMode(key);
                  writeLocal('orrery.tokenActivity.mode', key);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="icon-button activity-sync-btn"
            disabled={syncing}
            onClick={handleSync}
            title={activity?.lastSyncedAt ? `从各 Provider 同步本地数据（上次同步：${new Date(activity.lastSyncedAt).toLocaleTimeString()}）` : '从各 Provider 同步本地数据'}
            aria-label="同步各 Provider 本地数据"
          >
            <RefreshCw size={13} className={syncing ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="token-activity-stage" ref={stageRef} onMouseLeave={() => setHovered(null)}>
        <svg width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} role="img" aria-label="每日 Token 活动统计图">
          {mode === 'daily' && cells.map(cell => {
            if (cell.future) return null;
            const lv = levelOf(cell.total, dailyThresholds);
            const x = offsetX + cell.col * (cellSize + gap);
            const y = offsetY + cell.row * (cellSize + gap);
            return (
              <rect
                key={cell.date}
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                rx={rx}
                ry={rx}
                className={`activity-cell lv-${lv}`}
                onMouseEnter={() => {
                  const breakdown = effectiveProvider === 'all'
                    ? Object.entries(cell.byProvider)
                        .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
                        .map(([id, v]) => `${providers.find(p => p.id === id)?.name ?? id} ${formatTokens(v.totalTokens)}`)
                        .join(' · ')
                    : cell.total > 0
                      ? `输入 ${formatTokens(cell.input)} · 缓存 ${formatTokens(cell.cached)} · 输出 ${formatTokens(cell.output)}`
                      : '';
                  setHovered({
                    title: `${cell.date} ${WEEKDAYS[cell.row]}`,
                    subtitle: cell.total > 0 ? `${formatTokens(cell.total)} Tokens` : '无 Token 消耗',
                    detail: breakdown || undefined,
                  });
                }}
              />
            );
          })}

          {mode === 'weekly' && weeks.map((wk, col) => {
            const lv = levelOf(wk.total, weeklyThresholds);
            const x = offsetX + col * (cellSize + gap);
            const ratio = wk.total > 0 ? Math.max(0.08, wk.total / maxWeek) : 0;
            const barH = wk.total > 0 ? Math.max(4, Math.round(gridH * ratio)) : 3;
            const y = offsetY + gridH - barH;
            return (
              <g
                key={wk.startDate}
                onMouseEnter={() =>
                  setHovered({
                    title: `${wk.startDate} ~ ${wk.endDate.slice(5)}`,
                    subtitle: wk.total > 0 ? `周合计 ${formatTokens(wk.total)} Tokens` : '本周无消耗',
                    detail: wk.total > 0 ? `日均 ${formatTokens(Math.round(wk.total / 7))}` : undefined,
                  })
                }
              >
                <rect x={x} y={offsetY} width={cellSize} height={gridH} fill="transparent" />
                <rect x={x} y={y} width={cellSize} height={barH} rx={Math.min(rx, barH / 2)} className={`activity-cell lv-${lv}`} />
              </g>
            );
          })}

          {mode === 'cumulative' && cumulative.length > 1 && (() => {
            const span = Math.max(1, cumulative.length - 1);
            const coords = cumulative.map((pt, idx) => {
              const x = offsetX + (idx / span) * gridW;
              const y = offsetY + gridH - (pt.cumulative / maxCum) * (gridH - 4) - 2;
              return { ...pt, x, y };
            });
            const linePath = coords.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
            const areaPath = `${linePath} L${coords.at(-1)!.x.toFixed(1)},${(offsetY + gridH).toFixed(1)} L${coords[0].x.toFixed(1)},${(offsetY + gridH).toFixed(1)} Z`;
            const sliceW = gridW / coords.length;
            const gradId = `cum-grad-${resolvedRamp}-${customColor.slice(1)}`;
            return (
              <g>
                <defs>
                  <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--lv-3)" stopOpacity="0.34" />
                    <stop offset="100%" stopColor="var(--lv-3)" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <line x1={offsetX} x2={offsetX + gridW} y1={offsetY + gridH} y2={offsetY + gridH} className="chart-grid" />
                <line x1={offsetX} x2={offsetX + gridW} y1={offsetY + Math.round(gridH / 2)} y2={offsetY + Math.round(gridH / 2)} className="chart-grid" />
                <path d={areaPath} fill={`url(#${gradId})`} />
                <path d={linePath} fill="none" stroke="var(--lv-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                {coords.map((pt, idx) => (
                  <rect
                    key={pt.date}
                    x={offsetX + idx * sliceW}
                    y={offsetY}
                    width={Math.max(2, sliceW + 0.5)}
                    height={gridH}
                    fill="transparent"
                    onMouseEnter={() =>
                      setHovered({
                        title: pt.date,
                        subtitle: `累计 ${formatTokens(pt.cumulative)} Tokens`,
                        detail: pt.daily > 0 ? `当日新增 ${formatTokens(pt.daily)}` : '当日无新增',
                      })
                    }
                  />
                ))}
              </g>
            );
          })()}

          {monthLabels.map(m => (
            <text
              key={`${m.col}-${m.label}`}
              x={offsetX + m.col * (cellSize + gap)}
              y={offsetY + gridH + 14}
              className="activity-month-label"
            >
              {m.label}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}
