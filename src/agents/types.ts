import type {
  AgentId,
  AgentIsolation,
  Availability,
  Budget,
  DataMode,
  EngineCapabilities,
  EngineFailureCode,
  EngineId,
  ModelRef,
  Usage,
} from '@coderax/contracts';
import type {
  ReasoningMode,
  TaskEvidence,
  TaskPlan,
  TaskVerification,
} from '../domain.js';

/**
 * Agents execute an objective inside one confined workspace and report what they
 * did. They never own persistence, streaming or authorization: the engine passes
 * an owner-scoped request and a report sink. That is what keeps Native and the
 * external agents interchangeable without giving any of them a second task
 * runner or a path to private data.
 */

/**
 * One completed earlier turn. The engine builds these from the stored
 * conversation, so an agent sees a follow-up in context without owning storage.
 */
export type AgentHistoryTurn = {
  role: 'user' | 'assistant';
  text: string;
};

export type AgentRunRequest = {
  ownerId: string;
  tenantId: string | null;
  conversationId: string;
  /** The durable task this run belongs to; absent for a one-shot Chat turn. */
  taskId?: string;
  objective: string;
  /**
   * Earlier turns, oldest first. The current objective is not repeated here: it
   * is passed separately so an agent never answers the same message twice.
   */
  history?: AgentHistoryTurn[];
  /** Already resolved by the model catalogue; never a raw provider override. */
  model: ModelRef;
  mode: DataMode;
  workspaceRoot: string;
  maxSteps: number;
  budget: Budget | null;
  signal: AbortSignal;
  /** `auto` lets the agent choose; a resumed task passes its resolved mode. */
  reasoning?: 'auto' | 'fast' | 'complex';
  /** Steps the durable checkpoint already completed; resume skips exactly these. */
  completedSteps?: string[];
  /** The persisted dependency-aware plan, reused on resume or retry. */
  plan?: TaskPlan | null;
  /** Evidence already produced by completed steps in an earlier generation. */
  evidence?: TaskEvidence[];
  /** Iterations already consumed by a suspended generation; a resume continues the same bound. */
  iterationsUsed?: number;
};

export type AgentReportEvent =
  /** The planner produced or revised a dependency-aware plan; nothing ran yet. */
  | { type: 'plan.ready'; plan: TaskPlan; iterations?: number }
  | { type: 'budget'; iterations: number }
  | { type: 'step.started'; stepId: string; title: string; iterations?: number }
  | {
      type: 'step.completed';
      stepId: string;
      title: string;
      attempts?: number;
      evidence?: TaskEvidence;
      iterations?: number;
    }
  | { type: 'step.failed'; stepId: string; title: string; detail: string; iterations?: number }
  | { type: 'text.delta'; text: string }
  /** The agent replaced what it had streamed for this turn so far. */
  | { type: 'text.replace'; text: string }
  | { type: 'tool.call'; callId: string; tool: string; input?: unknown }
  | { type: 'tool.result'; callId: string; tool: string; ok: boolean; output?: string }
  | { type: 'file.edit'; path: string }
  | {
      type: 'approval.required';
      requestId: string;
      tool: string;
      description: string;
    };

export type AgentReport = (event: AgentReportEvent) => void;

export type AgentRunOutcome =
  | { ok: true; summary: string; usage?: Usage; verification?: TaskVerification }
  | {
      ok: false;
      code: EngineFailureCode;
      detail: string;
      retryable: boolean;
      /** Tokens spent before a terminal or suspended outcome. */
      usage?: Usage;
    };

export type { ReasoningMode };

export type AgentAdapter = {
  agent: AgentId;
  engine: EngineId;
  capabilities: EngineCapabilities;
  isolation: AgentIsolation;
  availability: () => Availability;
  /**
   * A live check that the agent can run now. `availability` is configuration
   * admission; this may contact the agent. Omitted when no honest probe exists.
   */
  probe?: () => Promise<{ ok: boolean; detail: string }>;
  run: (request: AgentRunRequest, report: AgentReport) => Promise<AgentRunOutcome>;
};
