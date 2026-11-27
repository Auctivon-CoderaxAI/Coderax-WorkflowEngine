import type { AgentHistoryTurn } from '../types.js';
export type { PlanStepKind, ReasoningMode, TaskPlan, TaskPlanStep } from '../../domain.js';
import type { ArtifactDescriptor, DeliverableRequestInput, EngineFailureCode, ModelRef, PermissionScope, Usage } from '@coderax/contracts';
import type { ReasoningMode, TaskEvidence, TaskPlan, TaskPlanStep } from '../../domain.js';
/**
 * The gateway port is owned by the model router: an agent names a resolved model
 * and never reaches a provider URL or key. Re-exported here so the native agent
 * does not import routing internals.
 */
export type {
  GatewayCompletion,
  GatewayRequest,
  GatewayStreamEvent,
  ModelGateway,
} from '../../models/types.js';

export type PlanStep = {
  id: string;
  title: string;
};

/**
 * Planning is a port so Native can use a deterministic planner today and a model
 * planner later without changing the run contract. A plan is data: the engine
 * persists completed step ids, which is what makes resume skip finished work.
 */
export type Planner = {
  plan: (input: { objective: string; maxSteps: number }) => PlanStep[];
};

export type ModelCompletionRequest = {
  model: ModelRef;
  system: string;
  prompt: string;
  /** Data URLs for validated image attachments on this turn. */
  images?: string[];
  signal: AbortSignal;
  maxOutputTokens?: number;
};

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
    /** Data URLs for validated image attachments on a Chat turn. */
    images?: string[];
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
export type ReasoningPlanner = {
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

export type BasicModelGateway = { id: string; complete: (request: ModelCompletionRequest) => Promise<{ text: string; usage?: Usage }> };
