import type {
  ArtifactDescriptor,
  DeliverableRequestInput,
  EngineFailureCode,
  ModelRef,
  Usage,
} from '@coderax/contracts';

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
