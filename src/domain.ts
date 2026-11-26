import type {
  AgentId,
  Budget,
  DataMode,
  EngineId,
  IsoDateTime,
  MissedRunPolicy,
  ModelRef,
  ScheduleCondition,
  ScheduleConditionState,
  ScheduleExecutionState,
  ScheduleLimits,
  ScheduleNoticeKind,
  ScheduleRetry,
  ScheduleState,
  ScheduleTiming,
  ScheduleTrigger,
  TaskState,
  Usage,
} from '@coderax/contracts';

export type TaskStep = {
  id: string;
  title: string;
  state: TaskState;
};

export type TaskCheckpoint = {
  /** Steps whose work is durably complete; a resume skips exactly these. */
  completedSteps: string[];
  /** Partial assistant text already emitted, replayed on resume. */
  text: string;
};

export type TaskResult = {
  summary?: string;
  artifacts: Array<{ path: string; bytes?: number; digest?: string }>;
};

export type TaskFailure = {
  code: string;
  detail?: string;
  retryable?: boolean;
};

/**
 * The authoritative record of a Work task. Only the engine writes it, and only
 * through a fenced repository call: `runToken` names the generation allowed to
 * write. A token is unique per claim, so a stale generation can never equal a
 * newer one.
 */
export type TaskRecord = {
  scheduleRetryClaimed?: boolean;
  handoffPending?: boolean;
  scheduleAdmission?: { scheduleId: string; executionId: string; complete?: boolean };
  taskId: string;
  ownerId: string;
  tenantId: string | null;
  conversationId: string;
  agent: AgentId;
  engine: EngineId;
  mode: DataMode;
  objective: string;
  model: ModelRef | null;
  state: TaskState;
  generation: number;
  runToken: string | null;
  steps: TaskStep[];
  checkpoint: TaskCheckpoint;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  leaseExpiresAt: IsoDateTime | null;
  cancelRequested: boolean;
  requireApproval: boolean;
  budget: Budget | null;
  usage: Usage | null;
  result: TaskResult | null;
  failure: TaskFailure | null;
};

export type TaskPatch = Partial<
  Pick<
    TaskRecord,
    | 'state'
    | 'handoffPending'
    | 'scheduleAdmission'
    | 'steps'
    | 'checkpoint'
    | 'updatedAt'
    | 'leaseExpiresAt'
    | 'cancelRequested'
    | 'runToken'
    | 'usage'
    | 'result'
    | 'failure'
    | 'model'
  >
>;

export type ConversationRecord = {
  conversationId: string;
  ownerId: string;
  tenantId: string | null;
  title?: string;
  mode: DataMode;
  isWork: boolean;
  agent: AgentId;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
};

export type StoredMessage = {
  messageId: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  createdAt: IsoDateTime;
  unfinished?: boolean;
  agent?: AgentId;
};

export type MemoryRecord = {
  ownerId: string;
  tenantId: string | null;
  mode: DataMode;
  key: string;
  value: string;
  updatedAt: IsoDateTime;
};

export type NotificationRecord = {
  taskId: string;
  ownerId: string;
  conversationId: string;
  agent: AgentId;
  mode: DataMode;
  state: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  summary?: string;
  createdAt: IsoDateTime;
  read: boolean;
};

export type ScheduleRecord = {
  scheduleId: string;
  ownerId: string;
  name: string;
  objective: string;
  agent: AgentId;
  model: ModelRef | null;
  mode: DataMode;
  timing: ScheduleTiming;
  timingRevision?: number;
  condition: ScheduleCondition;
  retry: ScheduleRetry;
  priority: number;
  limits: ScheduleLimits;
  /** Literal: a scheduled run always routes side effects through permissions. */
  requireApproval: true;
  missedRunPolicy: MissedRunPolicy;
  state: ScheduleState;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  nextRunAt: IsoDateTime | null;
  lastRunAt: IsoDateTime | null;
  lastExecutionId: string | null;
  runsTotal: number;
  acceptedDay?: { start: string; count: number };
  consecutiveFailures: number;
  accountedFailures?: string[];
  /** Compare-and-swap generation: only one replica advances a schedule once. */
  version: number;
  pausedAt: IsoDateTime | null;
  cancelledAt: IsoDateTime | null;
  cancelReason: string | null;
};

export type SchedulePatch = Partial<
  Pick<
    ScheduleRecord,
    | 'name'
    | 'timingRevision'
    | 'timing'
    | 'condition'
    | 'retry'
    | 'priority'
    | 'limits'
    | 'missedRunPolicy'
    | 'state'
    | 'nextRunAt'
    | 'lastRunAt'
    | 'lastExecutionId'
    | 'runsTotal'
    | 'acceptedDay'
    | 'consecutiveFailures'
    | 'accountedFailures'
    | 'updatedAt'
    | 'pausedAt'
    | 'cancelledAt'
    | 'cancelReason'
  >
>;

/**
 * One durable execution receipt. `executionKey` is unique across replicas and
 * occurrences, and `taskId` is deterministic, so a retried dispatch of the same
 * occurrence cannot create a second Work task.
 */
export type ScheduleExecutionRecord = {
  executionId: string;
  executionKey: string;
  claimGeneration?: number;
  admissionStarted?: boolean;
  failureAccountingPending?: boolean;
  noticePending?: boolean;
  completionNoticeSummary?: string;
  selectedTimingRevision?: number;
  scheduleId: string;
  ownerId: string;
  occurrenceKey: string;
  trigger: ScheduleTrigger;
  scheduledFor: IsoDateTime;
  state: ScheduleExecutionState;
  attempt: number;
  maxAttempts: number;
  taskId: string | null;
  conversationId: string;
  priority: number;
  detail: string | null;
  nextAttemptAt: IsoDateTime | null;
  condition: ScheduleConditionState;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
};

export type ScheduleExecutionPatch = Partial<
  Pick<
    ScheduleExecutionRecord,
    | 'state'
    | 'admissionStarted'
    | 'failureAccountingPending'
    | 'noticePending'
    | 'completionNoticeSummary'
    | 'attempt'
    | 'taskId'
    | 'detail'
    | 'nextAttemptAt'
    | 'condition'
    | 'updatedAt'
    | 'finishedAt'
  >
>;

export type ScheduleNoticeRecord = {
  noticeId: string;
  scheduleId: string;
  executionId: string;
  ownerId: string;
  kind: ScheduleNoticeKind;
  summary: string;
  createdAt: IsoDateTime;
  read: boolean;
};

export type AuditRecord = {
  at: IsoDateTime;
  actor: string;
  action: string;
  taskId?: string;
  conversationId?: string;
  outcome: 'accepted' | 'completed' | 'failed' | 'cancelled' | 'refused';
  receipt: string;
  detail?: string;
};
