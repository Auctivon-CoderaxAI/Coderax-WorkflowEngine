import type {
  AgentId,
  Budget,
  DataMode,
  EngineId,
  IsoDateTime,
  ModelRef,
  TaskAccepted,
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

export type CheckpointRecord = {
  checkpointId: string;
  taskId: string;
  ownerId: string;
  conversationId: string;
  generation: number;
  /** Steps whose work was durably complete at this point. */
  completedSteps: string[];
  /** Assistant text emitted so far, scrubbed before it is stored. */
  text: string;
  /** `step` records progress; `settled` is the checkpoint the run ended with. */
  kind: 'step' | 'settled';
  createdAt: IsoDateTime;
};

export type IdempotencyState = 'pending' | 'completed';

/**
 * One Work submission identity.
 *
 * The key is scoped to an owner and the request digest, so a retry of the same
 * request replays the original acceptance while a different request reusing the
 * key is refused instead of silently creating a second task.
 */
export type IdempotencyRecord = {
  ownerId: string;
  key: string;
  requestHash: string;
  state: IdempotencyState;
  /** Present once the submission completed; never recomputed from a guess. */
  response: TaskAccepted | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  expiresAt: IsoDateTime;
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
  objective: string;
  agent: AgentId;
  mode: DataMode;
  model: ModelRef | null;
  requireApproval: boolean;
  budget: Budget | null;
  state: 'scheduled' | 'submitted' | 'cancelled' | 'failed';
  runAt: IsoDateTime;
  intervalMs: number | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  nextRunAt: IsoDateTime | null;
  lastTaskId: string | null;
  lastError: string | null;
};

export type ArtifactRow = {
  artifactId: string;
  ownerId: string;
  taskId: string;
  path: string;
  mediaType: string;
  bytes: number;
  digest: string;
  mode: DataMode;
  createdAt: IsoDateTime;
};

export type AuditRecord = {
  at: IsoDateTime;
  /** The owner the evidence belongs to; `actor` is kept for the wire contract. */
  actor: string;
  action: string;
  taskId?: string;
  conversationId?: string;
  outcome: 'accepted' | 'completed' | 'failed' | 'cancelled' | 'refused';
  receipt: string;
  detail?: string;
  /** Correlation with the HTTP request that caused the evidence. */
  requestId?: string;
  mode?: DataMode;
};
