import { AlarmClock, CalendarClock, CirclePause, ListOrdered, Repeat2 } from 'lucide-react';
import type { ScheduledItem } from '@orrery/shared';
import { useNow } from '../../hooks/useNow';
import { formatClock, formatCountdown } from '../../lib/format';
import { EmptyState } from '../Telemetry';

const kinds = { queued_item: ['排队项', ListOrdered], scheduled_task: ['定时任务', CalendarClock], automation: ['自动化', Repeat2] } as const;
const states = { enabled: ['已启用', 'tone-green'], paused: ['已暂停', 'tone-muted'], queued: ['排队中', 'tone-blue'], running: ['运行中', 'tone-cyan'], failed: ['失败', 'tone-rose'] } as const;

export function QueueCronWidget({ scheduled }: { scheduled: ScheduledItem[] }) {
  const now = useNow();
  if (!scheduled.length) return <EmptyState icon={CalendarClock}>暂无排队项或定时任务</EmptyState>;
  return <div className="widget-scroll schedule-list">{scheduled.map(item => {
    const [kind, Icon] = kinds[item.kind];
    const [state, tone] = states[item.status];
    return <article className="schedule-row" key={item.source + '/' + item.id}>
      <div className="between"><span className="schedule-kind"><Icon size={14} />{kind}<small className={item.source === 't3' ? 'tone-blue' : 'tone-green'}>{item.source === 't3' ? 'T3' : 'Codex'}</small></span>
        <span className={`state-pill ${tone}`}><i className="dot" />{state}</span></div>
      <h3>{item.title}</h3>
      {item.scheduleText && <p className="schedule-rule mono">{item.scheduleText}</p>}
      <div className="schedule-times">
        {item.nextRunAt && <span><AlarmClock size={12} />下次 <time title={item.nextRunAt}>{formatCountdown(item.nextRunAt, now)}</time></span>}
        {(item.lastRunAt || item.lastRunStatus) && <span>上次 {item.lastRunAt && <time title={item.lastRunAt}>{formatClock(item.lastRunAt)}</time>} <b>{item.lastRunStatus}</b></span>}
        {item.status === 'paused' && !item.nextRunAt && <CirclePause size={12} />}
      </div>
      {item.lastError && <p className="error-snippet" title={item.lastError}>{item.lastError}</p>}
    </article>;
  })}</div>;
}
