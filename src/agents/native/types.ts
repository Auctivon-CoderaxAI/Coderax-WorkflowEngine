import type { ModelRef, RoutingMode, Usage } from '@coderax/contracts';
import type { AgentHistoryTurn } from '../types.js';

/** One tool advertised to a model that supports native function calling. */
export type ModelToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
};

export type ModelToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type ModelCompletion = {
  text: string;
  usage?: Usage;
  /** Present only when the provider answered with a native tool call. */
  toolCall?: ModelToolCall;
};

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
  /** The owner whose daily zero-cost budget this call is charged to. */
  ownerId?: string;
  /**
   * The exact tool catalogue text embedded in the prompt. It is counted as
   * input separately so token accounting cannot omit the largest fixed part of
   * a Native prompt.
   */
  toolSchemaText?: string;
  /** Ask the provider to stream; usage is folded from the streamed frames. */
  stream?: boolean;
  /** Native function definitions; absent means the JSON action protocol. */
  tools?: ModelToolDefinition[];
};

export type ModelGateway = {
  id: string;
  /** True only when the gateway can send `tools` on the provider wire. */
  supportsNativeTools?: boolean;
  complete: (request: ModelCompletionRequest) => Promise<ModelCompletion>;
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
 * Planning is a port so Native can use a deterministic planner today and a model
 * planner later without changing the run contract. A plan is data: the engine
 * persists the full graph before its first step, which is what makes resume
 * complete the work it promised rather than the part it already started.
 */
export type Planner = {
  plan: (input: {
    objective: string;
    maxSteps: number;
    history?: AgentHistoryTurn[];
    complete?: (prompt: string, signal: AbortSignal) => Promise<string>;
    signal?: AbortSignal;
  }) => Promise<PlanStep[]> | PlanStep[];
};
