import type {
  ArtifactDescriptor,
  DeliverableRequestInput,
  EngineFailureCode,
  ModelRef,
  PermissionScope,
  Usage,
} from '@coderax/contracts';
import type { AgentHistoryTurn } from '../types.js';
import type {
  PlanStepKind,
  ReasoningMode,
  TaskEvidence,
  TaskPlan,
  TaskPlanStep,
} from '../../domain.js';

export type ModelCompletionRequest = {
  model: ModelRef;
  system: string;
  prompt: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
};

export type ModelGateway = {
  id: string;
  complete: (request: ModelCompletionRequest) => Promise<{ text: string; usage?: Usage }>;
};

/**
 * A plan step is the unit the planner produces and the executor consumes. The
 * planner never calls a provider or reads a file; it only produces this data, so
 * planning cannot execute anything by construction.
 */
export type PlanStep = TaskPlanStep;
export type { PlanStepKind, ReasoningMode, TaskPlan, TaskPlanStep };

/**
 * One step's real output. `output` is context for later reasoning; `citation` is
 * the bounded, user-safe statement of what was produced, which is what a verifier
 * is allowed to rely on.
 */
export type StepEvidence = TaskEvidence;

export type StepActionFailure = {
  code:
    | 'provider_error'
    | 'invalid_output'
    | 'workspace_denied'
    | 'not_found'
    | 'too_large'
    | 'unsupported';
  detail: string;
  retryable: boolean;
};

export type ActionExecution =
  | { ok: true; text: string; citation?: string; usage?: Usage }
  | { ok: false; failure: StepActionFailure };

/**
 * The execution layer for one action. Every action is executed here and nowhere
 * else, so a planner or a prompt cannot reach a provider, a file or a network
 * resource on its own.
 */
export type ActionExecutor = {
  execute: (input: {
    step: TaskPlanStep;
    objective: string;
    mode: ReasoningMode;
    history: AgentHistoryTurn[];
    evidence: StepEvidence[];
    workspaceRoot: string;
    model: ModelRef;
    signal: AbortSignal;
    maxOutputTokens?: number;
    /** Set after a rejected answer so the correction is grounded in the failure. */
    feedback?: string;
  }) => Promise<ActionExecution>;
};

/**
 * The permission layer as Native sees it. `allowed` is only for an action with
 * no additional scope (inference under an owner-authorized task). Anything
 * scoped must be approved by the permission store; Native cannot grant itself.
 */
export type AuthorizationDecision =
  | { decision: 'allowed' }
  | { decision: 'approved'; requestId?: string }
  | { decision: 'requested'; requestId: string }
  | { decision: 'pending'; requestId: string }
  | { decision: 'denied'; requestId?: string };

export type ActionAuthorizer = {
  authorize: (input: {
    taskId: string;
    ownerId: string;
    agent: 'coderax';
    scope: PermissionScope | null;
    resource: string;
    description: string;
  }) => Promise<AuthorizationDecision>;
};

export type PlanInput = {
  objective: string;
  history: AgentHistoryTurn[];
  model: ModelRef;
  mode: ReasoningMode;
  completedSteps: string[];
  maxSteps: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
};

export type ReplanFailure = {
  reason: 'step_failed' | 'verification_failed';
  stepId?: string;
  detail: string;
};

export type ReplanInput = {
  objective: string;
  history: AgentHistoryTurn[];
  model: ModelRef;
  mode: ReasoningMode;
  plan: TaskPlan;
  completedSteps: string[];
  evidence: StepEvidence[];
  failure: ReplanFailure;
  maxSteps: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
};

export type PlanOutcome = {
  plan: TaskPlan;
  usage?: Usage;
};

/**
 * Planning is a port. It has no gateway of its own beyond the one it was given,
 * and it returns data only; the agent decides whether and how to execute it.
 */
export type Planner = {
  plan: (input: PlanInput) => Promise<PlanOutcome>;
  replan: (input: ReplanInput) => Promise<PlanOutcome>;
};

export type NativeLimits = {
  maxSteps: number;
  maxParallelSteps: number;
  maxReplans: number;
  maxStepAttempts: number;
  maxIterations: number;
};

/**
 * The deliverable use case, seen from the agent.
 *
 * The port keeps `src/agents` free of staging, persistence and permission
 * wiring: the composition root supplies the durable-backed implementation. A
 * generated deliverable is persisted with the task's association, so the task
 * result finds it through the artifact service rather than through this value.
 */
export type DeliverableTool = (input: {
  request: DeliverableRequestInput;
  ownerId: string;
  taskId?: string;
  conversationId: string;
  signal: AbortSignal;
}) => Promise<
  | { ok: true; descriptors: ArtifactDescriptor[]; summary: string }
  | { ok: false; code: EngineFailureCode; detail: string }
>;
