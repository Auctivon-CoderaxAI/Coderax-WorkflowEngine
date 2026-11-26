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
  /**
   * True only when the owner named the model. A route-chosen model stays
   * replaceable by a bounded fallback, including after a resume.
   */
  modelPinned?: boolean;
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
