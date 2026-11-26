import type {
  AgentRuntime,
  AttentionAlert,
  EventEntry,
  HostMetrics,
  ProcessMetric,
  QuotaWindow,
  ScheduledItem,
  TaskItem,
  TimelineSegment,
} from '@orrery/shared';

export interface CollectorOutput {
  adapterId: string;
  collectedAt: string;
  ok: boolean;
  error?: string;
  agents: AgentRuntime[];
  quotas: QuotaWindow[];
  tasks: TaskItem[];
  alerts: AttentionAlert[];
  scheduled: ScheduledItem[];
  events: EventEntry[];
  timeline?: TimelineSegment[];
  processes?: ProcessMetric[];
  host?: HostMetrics;
  todayTokens?: number;
}

export interface CollectorAdapter {
  readonly id: string;
  readonly name: string;
  readonly intervalMs: number;
  collect(): Promise<CollectorOutput>;
  dispose?(): Promise<void> | void;
}
