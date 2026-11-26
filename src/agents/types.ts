import type {
  AgentId,
  AgentIsolation,
  Availability,
  Budget,
  DataMode,
  EngineCapabilities,
  EngineFailureCode,
  EngineId,
  KnowledgeSearchResult,
  ModelRef,
  Usage,
} from '@coderax/contracts';
import type { PendingAction, StepOutput } from '../domain.js';
import type { ApprovalGate, ToolRuntime } from '../tools/types.js';

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

/**
 * Capabilities the engine lends to an agent for one turn. They are supplied per
 * run, never held by the adapter: an external agent receives no context at all,
 * and Native receives only what this owner's task is allowed to use.
 */
export type AgentContext = {
  taskId?: string | null;
  tools?: { runtime: ToolRuntime; gate: ApprovalGate };
  memory?: { list: () => Promise<string[]> };
  knowledge?: { search: (query: string, k: number) => Promise<KnowledgeSearchResult> };
  /** Persisted plan and finished steps, so a resume does not re-plan or re-run. */
  pendingAction?: PendingAction | null;
  savePendingAction?: (action: PendingAction | null) => Promise<boolean>;
  savePlan?: (steps: Array<{ id: string; title: string }>) => Promise<boolean>;
  plannedSteps?: Array<{ id: string; title: string }>;
  completedSteps?: string[];
  priorText?: string;
  priorOutputs?: StepOutput[];
  /** Owner approval policy for tool actions that need a decision. */
  requireApproval?: boolean;
};

export type AgentRunRequest = {
  ownerId: string;
  tenantId: string | null;
  conversationId: string;
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
  context?: AgentContext;
};

export type AgentReportEvent =
  | { type: 'step.started'; stepId: string; title: string }
  | { type: 'step.completed'; stepId: string; title: string; output?: string }
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
  | { ok: true; summary: string; usage?: Usage }
  | { ok: false; code: EngineFailureCode; detail: string; retryable: boolean };

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
