import type {
  AgentId,
  ArtifactKind,
  ArtifactMediaType,
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

/**
 * A durable artifact. The bytes live in the content-addressed blob store; this
 * row is the authoritative metadata and names the current immutable version.
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

/**
 * One firing of a schedule, kept so the owner can read what the engine did
 * without reconstructing it from task history.
 */
export type ScheduleExecutionRecord = {
  at: IsoDateTime;
  outcome: 'submitted' | 'skipped';
  /** The slot the schedule moved to after this firing. */
  nextRunAt: IsoDateTime;
  taskId: string | null;
  /** Stable refusal code for a skipped firing. */
  code: string | null;
};

/**
 * A durable schedule. It holds no lease and owns no run: a firing submits Work
 * and the ordinary execution invariants take over from there.
 */
export type ScheduleRecord = {
  scheduleId: string;
  ownerId: string;
  objective: string;
  agent: AgentId;
  mode: DataMode;
  intervalMs: number;
  enabled: boolean;
  conversationId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  nextRunAt: IsoDateTime | null;
  /** Start instant requested while paused; consumed by the next resume. */
  pendingStartAt: IsoDateTime | null;
  lastRunAt: IsoDateTime | null;
  lastTaskId: string | null;
  runs: number;
  skipped: number;
  /** Newest first, bounded by the store. */
  executions: ScheduleExecutionRecord[];
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
