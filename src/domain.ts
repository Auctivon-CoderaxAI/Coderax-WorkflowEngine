import type {
  AgentId,
  Budget,
  DataMode,
  EngineId,
  IsoDateTime,
  ModelRef,
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
