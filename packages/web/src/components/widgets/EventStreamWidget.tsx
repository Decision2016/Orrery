import { useState } from 'react';
import { Radio } from 'lucide-react';
import type { EventEntry } from '@orrery/shared';
import { formatClock } from '../../lib/format';
import { EmptyState, SourceBadge } from '../Telemetry';

const levels = { info: ['INFO', 'tone-blue'], tool: ['TOOL', 'tone-violet'], warn: ['WARN', 'tone-amber'], error: ['ERR', 'tone-rose'], done: ['DONE', 'tone-green'] } as const;
const filters = ['ALL', 'TOOL', 'WARN', 'ERR'] as const;

export function EventStreamWidget({ events, onSelect }: { events: EventEntry[]; onSelect: (id: string) => void }) {
  const [level, setLevel] = useState<typeof filters[number]>('ALL');
  const visible = level === 'ALL' ? events : events.filter(e => levels[e.level][0] === level);
  return <div className="widget-column"><div className="widget-toolbar"><div className="segments mono" aria-label="事件等级">
    {filters.map(f => <button key={f} aria-pressed={level === f} onClick={() => setLevel(f)}>{f}</button>)}
  </div></div>
    {visible.length ? <div className="widget-scroll event-list">{visible.map(event => {
      const [label, tone] = levels[event.level];
      const content = <><span className="event-meta"><time dateTime={event.timestamp}>{formatClock(event.timestamp)}</time>
        <span className={`event-level ${tone}`}>{label}</span><SourceBadge source={event.source} /></span>
        <span className="event-summary">{event.summary}</span></>;
      return event.taskId ? <button key={event.id} className="event-row" title={event.detail || event.taskTitle || event.summary} onClick={() => onSelect(event.taskId!)}>{content}</button>
        : <div key={event.id} className="event-row" title={event.detail}>{content}</div>;
    })}</div> : <EmptyState icon={Radio}>暂无匹配的事件</EmptyState>}
  </div>;
}
