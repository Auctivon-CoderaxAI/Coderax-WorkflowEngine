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

import type { AgentHistoryTurn } from '../types.js';

export type { AgentHistoryTurn } from '../types.js';

/** One tool advertised to a model that supports native function calling. */
export type ModelToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
};

/**
 * A dependency-aware plan step. `dependsOn` names earlier step ids; an empty
 * list means the step is ready when its turn in the plan arrives. A plan whose
 * graph contains a cycle is rejected rather than executed in an arbitrary order.
 */
export type PlanStep = {
  id: string;
  title: string;
  dependsOn: string[];
  /** Optional observable check the step itself claims to satisfy. */
  successCriteria?: string;
};

/**
 * Planning is a port so Native can plan deterministically and, when a verified
 * free model is routable, ask it for a plan with the deterministic result as a
 * floor. A plan is data: the engine persists the full graph before its first
 * step, which is what makes resume complete the work it promised rather than
 * the part it already started.
 */
export type Planner = {
  plan: (input: {
    objective: string;
    maxSteps: number;
    history?: AgentHistoryTurn[];
    signal?: AbortSignal;
    /** Supplied only when the caller can afford a model-assisted plan. */
    complete?: (prompt: string, signal: AbortSignal) => Promise<string>;
  }) => PlanStep[] | Promise<PlanStep[]>;
};
