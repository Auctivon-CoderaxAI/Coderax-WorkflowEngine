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
  RoutingMode,
  Usage,
} from '@coderax/contracts';
import type { ProcessingOperation } from '../models/policy.js';
import type { ApprovalGate, ToolRuntime } from '../tools/types.js';

/**
 * Agents execute an objective inside one confined workspace and report what they
 * did. They never own persistence, streaming or authorization: the engine passes
 * an owner-scoped request and a report sink. That is what keeps Native and the
 * external agents interchangeable without giving any of them a second task
 * runner or a path to private data.
 */

export type AgentHistoryTurn = {
  role: 'user' | 'assistant';
  text: string;
};

export type PlannedStep = {
  id: string;
  title: string;
  dependsOn?: string[];
  successCriteria?: string;
};

/** One tool call the engine dispatched, recorded before and after the effect. */
export type ExecutedToolAction = {
  stepId: string;
  digest: string;
  tool: string;
  callId: string;
  /**
   * `awaiting_approval` means the gate stopped the call before it could have an
   * effect, so the approved replay may execute exactly this call once.
   * `dispatched` means the engine started the call and does not know whether the
   * effect landed; it must never be replayed automatically.
   */
  state: 'awaiting_approval' | 'dispatched' | 'completed';
  ok: boolean;
  output: string;
};

export type AgentExecutionState = {
  /** Observations per step, so a resumed step keeps what it already learned. */
  observations: Record<string, string[]>;
  executed: ExecutedToolAction[];
};

export type StepResult = { id: string; title: string; text: string };

export type AgentContext = {
  taskId?: string | null;
  tools?: { runtime: ToolRuntime; gate: ApprovalGate };
  memory?: { list: () => Promise<string[]> };
  knowledge?: { search: (query: string, k: number) => Promise<KnowledgeSearchResult> };
  /** The exact action an owner decision applies to; kept until it is settled. */
  pendingAction?: {
    stepId: string;
    json: string;
    /** Execution slot bound to the approval; survives the suspension. */
    callId?: string;
    /** The exact decision the owner granted. */
    requestId?: string;
  } | null;
  savePendingAction?: (action: {
    stepId: string;
    json: string;
    callId?: string;
    requestId?: string;
  } | null) => Promise<boolean>;
  /** Persists the whole plan (and its graph) before its first step runs. */
  savePlan?: (steps: PlannedStep[]) => Promise<boolean>;
  plannedSteps?: PlannedStep[];
  completedSteps?: string[];
  completedResults?: StepResult[];
  priorText?: string;
  /** Durable observations and dispatched actions restored on resume. */
  executionState?: AgentExecutionState;
  saveExecutionState?: (state: AgentExecutionState) => Promise<boolean>;
  saveStepResult?: (result: StepResult) => Promise<boolean>;
  /** True only when the selected model's evidence records native tool support. */
  nativeTools?: boolean;
  /** Hard ceilings; the composition root supplies them from configuration. */
  maxActionsPerRun?: number;
  maxRunMs?: number;
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
  /** Automatic, Fast or Complex ranking, chosen by the engine from the task. */
  routing: RoutingMode;
  /** False pins the owner's explicit model; a route-chosen model may fall back. */
  allowFallback: boolean;
  mode: DataMode;
  /** The exact processing operation this run performs through the gateway. */
  operation: ProcessingOperation;
  workspaceRoot: string;
  maxSteps: number;
  budget: Budget | null;
  signal: AbortSignal;
  context?: AgentContext;
};

export type AgentReportEvent =
  | { type: 'step.started'; stepId: string; title: string }
  | { type: 'step.completed'; stepId: string; title: string; output?: string }
  | { type: 'step.blocked'; stepId: string; title: string; detail: string }
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
  | {
      ok: true;
      summary: string;
      usage?: Usage;
      /** The model that actually served the run, when routing replaced one. */
      model?: ModelRef;
      /** Model requests this run issued, for the durable per-task ledger. */
      requests?: number;
    }
  | {
      ok: false;
      code: EngineFailureCode;
      detail: string;
      retryable: boolean;
      requests?: number;
    };

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
  run: (
    request: AgentRunRequest,
    report: AgentReport,
    /** External adapters call this after probing and immediately before sending content. */
    admitDispatch?: () => boolean,
  ) => Promise<AgentRunOutcome>;
};
