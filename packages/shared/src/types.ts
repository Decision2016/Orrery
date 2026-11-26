export type SourceKind =
  | 't3'
  | 'codex-app'
  | 'codex-cli'
  | 't3-codex'
  | 'claude-code'
  | 'opencode'
  | 'antigravity';

export type TaskStatus =
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'queued'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'stale';

export type AgentHealthStatus = 'online' | 'degraded' | 'offline';

export interface ProcessMetric {
  pid: number;
  ppid: number;
  name: string;
  role: string;
  agentId: string;
  cpuPercent: number;
  memoryMb: number;
  commandLine?: string;
  startedAt?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  status: AgentHealthStatus;
  version?: string;
  runningCount: number;
  waitingCount: number;
  queuedCount: number;
  subagentCount: number;
  cpuPercent: number;
  memoryMb: number;
  processCount: number;
  pids: number[];
  endpointUrl?: string;
  detail?: string;
  lastSeenAt: string;
  cpuHistory?: number[];
  memoryHistory?: number[];
}

export interface QuotaWindow {
  providerId: string;
  providerName: string;
  windowId: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  checkedAt?: string;
  unavailableReason?: string;
}

export interface HostMetrics {
  cpuPercent: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  memoryPercent: number;
  agentProcessCount: number;
  uptimeSec: number;
  collectedAt: string;
}

export interface SubagentNode {
  id: string;
  parentId?: string;
  title: string;
  provider: string;
  model?: string;
  status: TaskStatus;
  currentStep?: string;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  origin?: string;
  childThreadId?: string;
}

export interface TaskStep {
  id: string;
  kind: 'tool_call' | 'command' | 'reasoning' | 'message' | 'approval' | 'subagent' | 'error';
  label: string;
  detail?: string;
  status: 'running' | 'completed' | 'failed' | 'waiting';
  startedAt: string;
  completedAt?: string;
}

export interface TokenMetrics {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  contextWindow?: number;
  contextPercent?: number;
}

export interface TaskExternalIds {
  t3ThreadId?: string;
  t3RunId?: string;
  t3ProviderThreadId?: string;
  codexThreadId?: string;
  rolloutPath?: string;
}

export interface TaskItem {
  id: string;
  externalIds: TaskExternalIds;
  source: SourceKind;
  sourceLabel: string;
  title: string;
  status: TaskStatus;
  project?: string;
  cwd?: string;
  gitBranch?: string;
  worktreePath?: string;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  runtimeMode?: string;
  currentStep?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs: number;
  tokens?: TokenMetrics;
  pendingApprovals: number;
  pendingInputs: number;
  hasActionablePlan: boolean;
  linkedPrUrl?: string;
  subagents: SubagentNode[];
  recentSteps: TaskStep[];
  errorMessage?: string;
  isStale?: boolean;
}

export interface AttentionAlert {
  id: string;
  taskId: string;
  source: SourceKind;
  sourceLabel: string;
  kind: 'approval' | 'user_input' | 'proposed_plan' | 'failed' | 'stale';
  severity: 'warning' | 'critical';
  title: string;
  detail?: string;
  project?: string;
  branch?: string;
  createdAt: string;
  ageMs: number;
  cwd?: string;
}

export interface ScheduledItem {
  id: string;
  source: 't3' | 'codex';
  kind: 'scheduled_task' | 'automation' | 'queued_item';
  title: string;
  status: 'enabled' | 'paused' | 'queued' | 'running' | 'failed';
  scheduleText?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  lastError?: string;
  runCount?: number;
  model?: string;
  cwd?: string;
}

export interface EventEntry {
  id: string;
  timestamp: string;
  source: SourceKind;
  level: 'info' | 'tool' | 'warn' | 'error' | 'done';
  taskId?: string;
  taskTitle?: string;
  summary: string;
  detail?: string;
}

export interface TimelineSegment {
  id: string;
  taskId: string;
  label: string;
  project?: string;
  source: SourceKind;
  provider: string;
  status: TaskStatus;
  startedAt: string;
  endedAt: string;
  isActive: boolean;
}

export interface TokenRatePoint {
  timestamp: string;
  tokensPerMin: number;
  activeTasks: number;
}

export interface SnapshotSummary {
  runningCount: number;
  waitingCount: number;
  queuedCount: number;
  failed24hCount: number;
  completed24hCount: number;
  todayTokens: number;
  activeSubagents: number;
}

export interface OrrerySnapshot {
  generatedAt: string;
  serverVersion: string;
  summary: SnapshotSummary;
  agents: AgentRuntime[];
  quotas: QuotaWindow[];
  host: HostMetrics;
  alerts: AttentionAlert[];
  tasks: TaskItem[];
  timeline: TimelineSegment[];
  scheduled: ScheduledItem[];
  events: EventEntry[];
  tokenHistory: TokenRatePoint[];
  processes: ProcessMetric[];
}

export type WidgetType =
  | 'agents'
  | 'quota-host'
  | 'attention'
  | 'active-tasks'
  | 'timeline'
  | 'inspector'
  | 'queue-cron'
  | 'event-stream'
  | 'token-chart';

export interface WidgetMeta {
  type: WidgetType;
  title: string;
  shortTitle: string;
  description: string;
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
}

export interface GridWidgetItem {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
  title?: string;
}

export interface LayoutPreset {
  id: string;
  name: string;
  description?: string;
  builtIn?: boolean;
  columns: number;
  rows: number;
  items: GridWidgetItem[];
  updatedAt: string;
}

export interface LayoutsPayload {
  activePresetId: string;
  presets: LayoutPreset[];
}
