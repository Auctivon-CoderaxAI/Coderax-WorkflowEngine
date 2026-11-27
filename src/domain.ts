import type {
  AgentId,
  ArtifactKind,
  ArtifactMediaType,
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

/**
 * Fast reasoning answers directly; complex reasoning decomposes, parallelises
 * independent work, verifies per objective and may replan within a bound.
 */
export type ReasoningMode = 'fast' | 'complex';

/**
 * Native may reason or read a confined workspace file. A read is the only
 * side-effecting-adjacent action it plans, and it always passes the permission
 * layer before it executes.
 */
export type PlanStepKind = 'reason' | 'read';

export type TaskPlanStep = {
  id: string;
  title: string;
  /** Ids of steps that must complete first. Empty means it is ready now. */
  dependsOn: string[];
  kind: PlanStepKind;
  /** Exact workspace-relative resource for a read step; never a host path. */
  resource?: string;
  /** What the step must prove to count as complete. */
  acceptance?: string;
};

/**
 * The persisted plan is data, not process state. A resumed generation reads it
 * back instead of asking a model to plan the same objective again, so a replay
 * executes the plan the owner was shown.
 */
export type TaskPlan = {
  revision: number;
  mode: ReasoningMode;
  steps: TaskPlanStep[];
  /** Why the planner chose a deterministic fallback, when it did. */
  note?: string;
};

export type TaskStep = {
  id: string;
  title: string;
  state: TaskState;
  dependsOn?: string[];
  attempts?: number;
};

/**
 * A bounded record of what a step actually produced. Verification and later
 * steps read this, and it is persisted so a resumed generation does not have to
 * invent evidence for work that finished in a previous process.
 */
export type TaskEvidence = {
  stepId: string;
  title: string;
  /** User-safe citation of the produced result. */
  citation: string;
  /** Bounded output used as context by dependent steps. */
  output: string;
  attempts: number;
};

export type TaskCheckpoint = {
  /** Steps whose work is durably complete; a resume skips exactly these. */
  completedSteps: string[];
  /** Partial assistant text already emitted, replayed on resume. */
  text: string;
  /** The dependency-aware plan this generation is executing. */
  plan: TaskPlan | null;
  /** Evidence produced by completed steps, bounded per step. */
  evidence: TaskEvidence[];
  /** Iterations consumed before a suspension; a resume continues this bound. */
  iterations?: number;
};

/**
 * Completion is only reported after evidence was collected and a verifier
 * checked it. `evidence` is bounded, user-safe text and never a fabricated
 * claim; an empty list means the objective was not verified.
 */
export type TaskVerification = {
  passed: boolean;
  reason: string;
  evidence: string[];
};

export type TaskResult = {
  summary?: string;
  artifacts: Array<{ path: string; bytes?: number; digest?: string }>;
  verification?: TaskVerification;
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
  /** Resolved on the first planning pass; never guessed by a client. */
  reasoning: ReasoningMode | null;
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
    | 'reasoning'
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

/**
 * Durable artifact metadata. The bytes live in a content-addressed blob and are
 * named only by `sha256`; the file name here is metadata and never a path.
 */
export type ArtifactRecord = {
  artifactId: string;
  ownerId: string;
  tenantId: string | null;
  mode: DataMode;
  kind: ArtifactKind;
  filename: string;
  /** Metadata only; never a filesystem path. Basename equals `filename`. */
  relativePath?: string;
  /** Normalized, case-folded path identity used only for collision checks. */
  pathKey?: string;
  mediaType: ArtifactMediaType;
  bytes: number;
  sha256: string;
  /** Current version number. Immutable version rows live alongside. */
  version: number;
  /** Retained version count, including the current one. */
  versions: number;
  projectId: string | null;
  conversationId: string | null;
  taskId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  expiresAt: IsoDateTime | null;
};

export type ArtifactVersionRecord = {
  ownerId: string;
  mode: DataMode;
  artifactId: string;
  version: number;
  filename: string;
  relativePath?: string;
  mediaType: ArtifactMediaType;
  /** Immutable per version, so a rollback restores the kind that version had. */
  kind: ArtifactKind;
  /** Size and digest of this exact version, so history is independently auditable. */
  bytes: number;
  sha256: string;
  note?: string;
  createdAt: IsoDateTime;
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
