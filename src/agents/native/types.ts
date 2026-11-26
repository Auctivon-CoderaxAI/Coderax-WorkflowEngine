import type {
  Artifact,
  DataMode,
  DeliverableRequest,
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
 * The artifact toolkit, seen from the agent. The port keeps `src/agents` free of
 * filesystem, persistence and permission wiring: the composition root supplies a
 * confined implementation that records its own receipts.
 */
export type DeliverableTool = (input: {
  request: DeliverableRequest;
  workspaceRoot: string;
  mode: DataMode;
  signal: AbortSignal;
}) => Promise<
  | { ok: true; artifacts: Artifact[]; summary: string }
  | { ok: false; code: EngineFailureCode; detail: string }
>;
