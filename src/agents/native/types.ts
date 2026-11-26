import type { ModelRef, RoutingMode, Usage } from '@coderax/contracts';
import type { AgentHistoryTurn } from '../types.js';

export type ModelCompletionRequest = {
  model: ModelRef;
  system: string;
  prompt: string;
  signal: AbortSignal;
  maxOutputTokens?: number;
  /** Set by the agent so routing ranks models for the work being done. */
  routingMode?: RoutingMode;
  /** Only a tool-capable model may serve an action turn. */
  requiresTools?: boolean;
  requiresVision?: boolean;
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
  plan: (input: {
    objective: string;
    maxSteps: number;
    /** Earlier turns, so a model plan sees the same context the run does. */
    history?: AgentHistoryTurn[];
    /** Present when a model-assisted plan is possible; its absence is not an error. */
    complete?: (prompt: string, signal: AbortSignal) => Promise<string>;
    signal?: AbortSignal;
  }) => Promise<PlanStep[]> | PlanStep[];
};
