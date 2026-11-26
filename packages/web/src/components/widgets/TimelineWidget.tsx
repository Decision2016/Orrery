import { useMemo, useState } from 'react';
import { GanttChart } from 'lucide-react';
import type { TimelineSegment } from '@orrery/shared';
import { useNow } from '../../hooks/useNow';
import { formatClock, sourceNames, statusColorClass, statusLabel } from '../../lib/format';
import { EmptyState } from '../Telemetry';

const ranges = [2, 6, 24];
const ticks = [0, 1, 2, 3, 4];
const nowX = 97;

export function TimelineWidget({ segments, selectedId, onSelect }: {
  segments: TimelineSegment[]; selectedId?: string; onSelect: (id: string) => void;
}) {
  const now = useNow();
  const [hours, setHours] = useState(2);
  const span = hours * 3600000;
  const from = now - span;
  const ordered = useMemo(() => segments.map(segment => ({
    segment, start: Date.parse(segment.startedAt), end: Date.parse(segment.endedAt),
  })).sort((a, b) => a.start - b.start), [segments]);
  type Bar = { segment: TimelineSegment; start: number; end: number };
  const groups = new Map<string, Bar[][]>();
  ordered.forEach(({ segment, start, end }) => {
    const finish = segment.isActive ? now : Math.min(now, end);
    if (!(finish >= from && start <= now && finish >= start)) return;
    const key = sourceNames[segment.source] + (segment.provider && !sourceNames[segment.source].toLowerCase().includes(segment.provider.toLowerCase()) ? ' / ' + segment.provider : '');
    const lanes = groups.get(key) ?? [];
    const lane = lanes.find(row => row.at(-1)!.end <= start);
    const bar = { segment, start: Math.max(from, start), end: finish };
    if (lane) lane.push(bar); else lanes.push([bar]);
    groups.set(key, lanes);
  });
  return <div className="widget-column timeline-widget">
    <div className="widget-toolbar"><div className="segments mono" aria-label="时间范围">{ranges.map(h =>
      <button key={h} aria-pressed={hours === h} onClick={() => setHours(h)}>{h}h</button>)}</div>
      <div className="timeline-legend"><span className="tone-cyan"><i className="dot" />运行</span>
        <span className="tone-amber"><i className="dot" />等待</span><span className="tone-green"><i className="dot" />完成</span></div>
    </div>
    <div className="widget-scroll timeline-scroll">
      <div className="lane axis-row"><span className="lane-label">来源 / Agent</span><div className="lane-track">
        {ticks.slice(0, -1).map(t => <time key={t} style={{ left: (t * nowX / 4) + '%' }}>{formatClock(from + t * span / 4, false)}</time>)}
        <span className="now-label" style={{ left: nowX + '%' }}>NOW</span>
      </div></div>
      {groups.size ? [...groups].map(([name, lanes]) => <div className="lane-group" key={name}>{lanes.map((bars, index) =>
        <div className="lane" key={index}><span className={`lane-label ${index ? 'continuation' : ''}`} title={name}>{index ? '↳ ' : ''}{name}</span>
          <div className="lane-track">{ticks.slice(0, -1).map(t => <i className="time-rule" key={t} style={{ left: (t * nowX / 4) + '%' }} />)}
            <i className="now-line" style={{ left: nowX + '%' }} />
            {bars.map(({ segment, start, end }) => {
              const title = [segment.label, name, segment.project, statusLabel(segment.status), formatClock(segment.startedAt) + ' – ' + (segment.isActive ? 'NOW' : formatClock(segment.endedAt))].filter(Boolean).join(' · ');
              return <button key={segment.id} data-source={segment.source} className={`gantt-bar ${statusColorClass(segment.status)} ${segment.taskId === selectedId ? 'selected' : ''}`}
                style={{ left: ((start - from) / span * nowX) + '%', width: ((end - start) / span * nowX) + '%' }}
                aria-label={title} title={title} onClick={() => onSelect(segment.taskId)}><span>{segment.label}</span></button>;
            })}</div>
        </div>)}</div>) : <EmptyState icon={GanttChart}>最近 {hours} 小时没有匹配的任务</EmptyState>}
    </div>
  </div>;
}
