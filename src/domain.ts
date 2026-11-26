import type {
  AgentId,
  Budget,
  DataMode,
  EngineId,
  IsoDateTime,
  ModelRef,
  TaskState,
  TeamCheck,
  TeamLimits,
  TeamMemberState,
  TeamState,
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
  pendingAction?: PendingAction | null;
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
