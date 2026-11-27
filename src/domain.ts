import type {
  AgentId,
  ArtifactKind,
  ArtifactMediaType,
  Budget,
  DataMode,
  EngineId,
  GameAction,
  GameObjective,
  IsoDateTime,
  MissedRunPolicy,
  ModelRef,
  PermissionScope,
  TaskState,
  TeamCheck,
  TeamLimits,
  TeamMemberState,
  TeamState,
  Usage,
} from '@coderax/contracts';

/**
 * A game session runs as a durable Work task. The workload discriminator is what
 * lets the same lease, fencing, cancellation and event machinery supervise a
 * gaming-agent session without a second executor.
 */
export type TaskWorkload = 'work' | 'game';

export type GameRunSpec = {
  sessionId: string;
  gameId: string;
  buildId: string;
  objective: GameObjective;
  allowedActions: GameAction[];
  maxTicks: number;
};

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

export type PendingAction = {
  stepId: string;
  json: string;
  observations?: string[];
  priorActions?: number;
  invalidAnswers?: number;
};

export type StepOutput = { stepId: string; text: string };

export type TaskCheckpoint = {
  /** Steps whose work is durably complete; a resume skips exactly these. */
  completedSteps: string[];
  outputs?: StepOutput[];
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
 * The owner's decision on one permission request, stored on the task row so it
 * survives a restart and is consumed exactly once. The in-process request list is
 * only the prompt; the durable row is the grant.
 */
export type TaskApproval = {
  requestId: string;
  scope: PermissionScope;
  resource: string;
  decision: 'approved' | 'denied';
  decidedAt: IsoDateTime;
  consumedAt?: IsoDateTime;
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
  /** Absent on records written before game sessions existed: read it as 'work'. */
  kind?: TaskWorkload;
  game?: GameRunSpec | null;
  objective: string;
  model: ModelRef | null;
  /**
   * True only when the owner named the model. A route-chosen model stays
   * replaceable by a bounded fallback, including after a resume.
   */
  modelPinned?: boolean;
  state: TaskState;
  generation: number;
  runToken: string | null;
  /**
   * The highest event sequence the durable log holds for this task, absent rows
   * read as 0. It lives on the fenced row so allocating a sequence and proving
   * ownership are one atomic operation.
   */
  eventSeq: number;
  /** Resolved on the first planning pass; never guessed by a client. */
  reasoning: ReasoningMode | null;
  steps: TaskStep[];
  pendingAction?: PendingAction | null;
  checkpoint: TaskCheckpoint;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  leaseExpiresAt: IsoDateTime | null;
  cancelRequested: boolean;
  requireApproval: boolean;
  /** Durable owner decision; null until one is recorded. */
  approval: TaskApproval | null;
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
    | 'pendingAction'
    | 'checkpoint'
    | 'updatedAt'
    | 'leaseExpiresAt'
    | 'cancelRequested'
    | 'runToken'
    | 'approval'
    | 'usage'
    | 'result'
    | 'failure'
    | 'model'
    | 'reasoning'
  >
>;

/**
 * Reasoning and planning are data, never side effects. The team planner validates
 * the owner's dependency graph with the same rules the Native planner uses; the
 * schedule is derived from it and persisted, so a restart resumes the same plan.
 */
export type ReasoningMode = 'fast' | 'complex';
export type PlanStepKind = 'reason' | 'read';

export type TaskPlanStep = {
  id: string;
  title: string;
  dependsOn: string[];
  kind: PlanStepKind;
  resource?: string;
  acceptance?: string;
};

export type TaskPlan = {
  revision: number;
  mode: ReasoningMode;
  steps: TaskPlanStep[];
  note?: string;
};

export type TaskEvidence = {
  stepId: string;
  title: string;
  output: string;
  citation: string;
  attempts: number;
};

export type TaskVerification = {
  passed: boolean;
  reason: string;
  evidence: string[];
};

/** A file the engine read and hashed itself while executing this team. */
export type TeamArtifact = {
  path: string;
  bytes: number;
  sha256: string;
  memberId: string;
};

export type TeamMemberRecord = {
  memberId: string;
  agent: AgentId;
  objective: string;
  dependsOn: string[];
  resources: string[];
  state: TeamMemberState;
  attempts: number;
  executionId?: string;
  summary?: string;
  /** Bounded text produced by the member; it is context, never a verdict. */
  evidence?: string;
  failure?: { code: string; detail?: string; retryable?: boolean };
  usage?: Usage;
  startedAt?: IsoDateTime;
  finishedAt?: IsoDateTime;
};

export type TeamCheckpoint = {
  /** Members whose work is durably complete; a resume skips exactly these. */
  completedMembers: string[];
  /** Per-member bounded output, reused as context by later members. */
  outputs: Record<string, string>;
  artifacts: TeamArtifact[];
  /** Evidence ids the verifier may cite: one per completed member. */
  evidence: TaskEvidence[];
};

export type TeamVerificationRecord = {
  passed: boolean;
  reason: string;
  checks: Array<{ checkId: string; kind: TeamCheck['kind']; passed: boolean; detail: string }>;
  artifacts: Array<{ path: string; bytes: number; sha256: string }>;
};

export type TeamFailure = {
  code: string;
  detail?: string;
  retryable?: boolean;
};

/**
 * The authoritative team snapshot. It is written only through `updateFenced`
 * with the generation's run token, and it carries the completed members, their
 * evidence and the artifacts, which is what makes a restart resume rather than
 * repeat work.
 */
export type TeamRecord = {
  teamId: string;
  ownerId: string;
  tenantId: string | null;
  conversationId: string;
  mode: DataMode;
  objective: string;
  reasoning: ReasoningMode;
  state: TeamState;
  generation: number;
  runToken: string | null;
  members: TeamMemberRecord[];
  /** The validated dependency graph the members came from. */
  plan: TaskPlan;
  checks: TeamCheck[];
  limits: TeamLimits;
  checkpoint: TeamCheckpoint;
  verification: TeamVerificationRecord | null;
  failure: TeamFailure | null;
  cancelRequested: boolean;
  budget: Budget | null;
  usage: Usage | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  finishedAt: IsoDateTime | null;
  /** Heartbeat of the replica that owns the run; a stale one is interrupted. */
  heartbeatAt: IsoDateTime | null;
};

export type TeamPatch = Partial<
  Pick<
    TeamRecord,
    | 'state'
    | 'members'
    | 'checkpoint'
    | 'verification'
    | 'failure'
    | 'cancelRequested'
    | 'runToken'
    | 'usage'
    | 'updatedAt'
    | 'startedAt'
    | 'finishedAt'
    | 'heartbeatAt'
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

/**
 * Durable artifact metadata. The bytes live in a content-addressed blob and are
 * named only by `sha256`; the file name here is metadata and never a path.
 */
export type ArtifactRecord = {
  mutationRevision?: number;
  slotTracked?: boolean;
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
  reservationId?: string;
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
