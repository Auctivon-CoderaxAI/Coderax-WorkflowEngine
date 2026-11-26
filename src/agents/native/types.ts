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

export type { AgentHistoryTurn } from '../types.js';

export type PlanStep = {
  id: string;
  title: string;
};

/**
 * Planning is a port so Native can plan deterministically and, when a verified
 * free model is routable, ask it for a plan with the deterministic result as a
 * floor. A plan is data: the engine persists completed step ids, which is what
 * makes resume skip finished work.
 */
export type Planner = {
  plan: (input: {
    objective: string;
    maxSteps: number;
    history?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
    signal?: AbortSignal;
    /** Supplied only when the caller can afford a model-assisted plan. */
    complete?: (prompt: string, signal: AbortSignal) => Promise<string>;
  }) => PlanStep[] | Promise<PlanStep[]>;
};
