import type { ModelRef, Usage } from '@coderax/contracts';

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
