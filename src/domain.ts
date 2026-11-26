import type {
  AgentId,
  Budget,
  CreativeRequest,
  DataMode,
  EngineId,
  IsoDateTime,
  MediaReference,
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
};

export type TaskResult = {
  summary?: string;
  artifacts: Array<{
    path: string;
    bytes?: number;
    digest?: string;
    sha256?: string;
    mediaType?: string;
    title?: string;
    /** Validated creative text; never written to the workspace. */
    content?: string;
  }>;
};

/**
 * A validated input image, kept with the task so a resume on another replica
 * still has the exact bytes the owner submitted. The reference is public; the
 * bytes are internal and never appear in a status or event.
 */
export type StoredMedia = {
  reference: MediaReference;
  dataBase64: string;
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
  pendingAction?: PendingAction | null;
  /** Validated image input; empty for a text-only task. */
  media: StoredMedia[];
  /** A requested creative deliverable, produced and validated at settlement. */
  creative: CreativeRequest | null;
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
    | 'pendingAction'
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
  /** Attachment metadata only; the transcript never embeds image bytes. */
  media?: MediaReference[];
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
