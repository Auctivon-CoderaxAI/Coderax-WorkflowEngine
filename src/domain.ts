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

export type TaskStep = {
  id: string;
  title: string;
  state: TaskState;
};

export type PendingAction = {
  stepId: string;
  json: string;
  /** Execution slot bound to the owner's decision; survives suspension. */
  callId?: string;
  /** The exact decision this action was approved for. */
  requestId?: string;
  observations?: string[];
  priorActions?: number;
  invalidAnswers?: number;
};

export type StepOutput = { stepId: string; text: string };

export type TaskPlanStep = {
  id: string;
  title: string;
  dependsOn: string[];
  successCriteria?: string;
};

export type TaskExecutedAction = {
  stepId: string;
  digest: string;
  tool: string;
  callId: string;
  /**
   * `awaiting_approval` had no effect and may be replayed once approved.
   * `dispatched` means the effect is unknown and must not be replayed.
   */
  state: 'awaiting_approval' | 'dispatched' | 'completed';
  ok: boolean;
  output: string;
};

export type TaskCheckpoint = {
  /** Steps whose work is durably complete; a resume skips exactly these. */
  completedSteps: string[];
  outputs?: StepOutput[];
  /** Partial assistant text already emitted, replayed on resume. */
  text: string;
  /**
   * The full plan is written before the first step. A resume must finish the
   * work it promised, not only the part whose steps already started.
   */
  plan?: TaskPlanStep[] | null;
  stepResults?: Array<{ id: string; title: string; text: string }>;
  /**
   * Durable observations and every tool call the engine dispatched. A resumed
   * generation uses this ledger instead of the model's recollection.
   */
  executionState?: {
    observations: Record<string, string[]>;
    executed: TaskExecutedAction[];
  };
};

/**
 * Internal terminal evidence. It is persisted with the task but is not part of
 * the public contract until the unified API surface adopts it.
 */
export type ExecutionReceipt = {
  receiptId: string;
  taskId: string;
  generation: number;
  agent: AgentId;
  engine: EngineId;
  mode: DataMode;
  model?: ModelRef;
  state: 'completed' | 'failed' | 'cancelled';
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime;
  usage?: Usage;
  requests?: number;
  steps: Array<{ id: string; title: string; state: TaskState }>;
  toolCalls: Array<{ callId: string; tool: string; ok: boolean; digest: string }>;
  planDigest: string;
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
  taskId: string;
  ownerId: string;
  tenantId: string | null;
  conversationId: string;
  agent: AgentId;
  engine: EngineId;
  mode: DataMode;
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
  steps: TaskStep[];
  pendingAction?: PendingAction | null;
  checkpoint: TaskCheckpoint;
  /** Terminal evidence of what the engine observed, never model narrative. */
  receipt?: ExecutionReceipt | null;
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
    | 'pendingAction'
    | 'checkpoint'
    | 'receipt'
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
