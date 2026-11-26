import type {
  ArtifactDescriptor,
  DataMode,
  DeliverableRequest,
  EngineFailureCode,
} from '@coderax/contracts';

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

/**
 * The artifact toolkit, seen from the agent. The port keeps `src/agents` free of
 * filesystem, persistence and permission wiring: the composition root supplies a
 * confined implementation that persists through the durable artifact service.
 *
 * A deliverable is only successful when the durable service returned a
 * descriptor for every file; a workspace path alone is never a completion
 * signal.
 */
export type DeliverableTool = (input: {
  request: DeliverableRequest;
  workspaceRoot: string;
  mode: DataMode;
  signal: AbortSignal;
  taskId?: string;
  conversationId?: string;
}) => Promise<
  | { ok: true; artifacts: ArtifactDescriptor[]; summary: string }
  | { ok: false; code: EngineFailureCode; detail: string }
>;
