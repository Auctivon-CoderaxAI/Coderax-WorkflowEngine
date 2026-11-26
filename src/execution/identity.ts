import type { AgentId, DataMode } from '@coderax/contracts';
import type { TerminationRecord } from './termination.js';

/**
 * A durable execution identity.
 *
 * A task id is not enough to name one run. The same task is executed again after
 * an interruption, a retry or an approval, each time under a new fencing token.
 * An execution id names exactly one attempt, so capability revocation, a
 * cancellation and an audit record all refer to the attempt that produced them.
 *
 * `taskId` is null only for Chat, which is not a Work task and has no lease. It
 * still receives an identity: a Chat turn that can call tools must be revocable
 * for the same reasons a Work run is.
 */
export type ExecutionKind = 'work' | 'chat';

export type ExecutionPhase = 'starting' | 'running' | 'finished';

/**
 * Why an execution ended. These are distinct on purpose:
 *
 * - `completed`, `failed`: the run reached its own conclusion.
 * - `cancelled`: the owner asked for it to stop.
 * - `interrupted`: the engine lost authority (lease lapse, a newer generation,
 *   or a replica that stopped). The task is resumable and no terminal write was
 *   made by this generation.
 * - `shutdown`: the process is stopping. It is neither the owner's decision nor
 *   a failure, so the task is left for startup reconciliation.
 * - `suspended`: the run is waiting for an owner approval decision.
 */
export type ExecutionCause =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'shutdown'
  | 'suspended';

export type ExecutionIdentity = {
  executionId: string;
  kind: ExecutionKind;
  taskId: string | null;
  conversationId: string;
  ownerId: string;
  tenantId: string | null;
  agent: AgentId;
  mode: DataMode;
  /** The task generation this attempt belongs to; 0 for Chat. */
  generation: number;
  /** The fencing token, present for Work and null for Chat. */
  token: string | null;
};

export type ExecutionRecord = ExecutionIdentity & {
  workspaceRoot: string;
  phase: ExecutionPhase;
  cause: ExecutionCause | null;
  startedAt: string;
  /** Refreshed by the supervisor so a startup sweep can tell stale from live. */
  lastHeartbeatAt: string;
  finishedAt: string | null;
  termination: TerminationRecord | null;
  capabilityRevokedAt: string | null;
  /** Number of tool calls that could create an external process. */
  processUseCount: number;
};

export type ExecutionSummary = {
  executionId: string;
  taskId: string | null;
  kind: ExecutionKind;
  phase: ExecutionPhase;
  cause: ExecutionCause | null;
  termination: TerminationRecord | null;
  startedAt: string;
  finishedAt: string | null;
  processUseCount: number;
};

export function summarizeExecution(record: ExecutionRecord): ExecutionSummary {
  return {
    executionId: record.executionId,
    taskId: record.taskId,
    kind: record.kind,
    phase: record.phase,
    cause: record.cause,
    termination: record.termination,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    processUseCount: record.processUseCount,
  };
}
