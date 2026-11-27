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
