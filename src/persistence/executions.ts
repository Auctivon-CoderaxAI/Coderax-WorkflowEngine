import type { ExecutionCause, ExecutionRecord } from '../execution/identity.js';
import type { TerminationRecord } from '../execution/termination.js';

/**
 * The durable identity of every supervised attempt.
 *
 * A task row says what work exists; an execution row says which attempt ran it,
 * whether it still holds authority and how it ended. The two are separate so a
 * capability revocation can name one attempt without rewriting the task, and so a
 * Chat turn — which has no task — still has a record that outlives the request.
 *
 * `finish` is guarded by the current phase: only the first terminal transition
 * applies. That mirrors task fencing at the execution level, so a late path from
 * an aborted run cannot overwrite the cause another path already recorded.
 */
export type FinishExecutionInput = {
  executionId: string;
  cause: ExecutionCause;
  finishedAt: string;
  termination: TerminationRecord;
  capabilityRevokedAt: string;
  processUseCount: number;
  detail?: string;
};

export type ExecutionRepository = {
  create: (record: ExecutionRecord) => Promise<boolean>;
  get: (executionId: string) => Promise<ExecutionRecord | null>;
  heartbeat: (executionId: string, at: string) => Promise<boolean>;
  finish: (input: FinishExecutionInput) => Promise<ExecutionRecord | null>;
  listActive: () => Promise<ExecutionRecord[]>;
  listByTask: (taskId: string) => Promise<ExecutionRecord[]>;
  /**
   * Retires attempts whose owning process stopped heartbeating.
   *
   * Only records older than `before` are retired: a live execution on another
   * replica keeps its heartbeat fresh, so a startup sweep on this replica cannot
   * retire it.
   */
  retireStale: (input: { before: string; at: string }) => Promise<number>;
};

export function createExecutionRepository(): ExecutionRepository {
  const records = new Map<string, ExecutionRecord>();

  function copy(record: ExecutionRecord): ExecutionRecord {
    return {
      ...record,
      termination: record.termination ? { ...record.termination } : null,
    };
  }

  return {
    create: async (record) => {
      if (records.has(record.executionId)) return false;
      records.set(record.executionId, copy(record));
      return true;
    },

    get: async (executionId) => {
      const record = records.get(executionId);
      return record ? copy(record) : null;
    },

    heartbeat: async (executionId, at) => {
      const record = records.get(executionId);
      if (!record || record.phase === 'finished') return false;
      record.lastHeartbeatAt = at;
      return true;
    },

    finish: async (input) => {
      const record = records.get(input.executionId);
      if (!record || record.phase === 'finished') return null;
      const next: ExecutionRecord = {
        ...record,
        phase: 'finished',
        cause: input.cause,
        lastHeartbeatAt: input.finishedAt,
        finishedAt: input.finishedAt,
        termination: { ...input.termination },
        capabilityRevokedAt: input.capabilityRevokedAt,
        processUseCount: input.processUseCount,
      };
      records.set(input.executionId, next);
      return copy(next);
    },

    listActive: async () =>
      [...records.values()]
        .filter((record) => record.phase !== 'finished')
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map(copy),

    listByTask: async (taskId) =>
      [...records.values()]
        .filter((record) => record.taskId === taskId)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .map(copy),

    retireStale: async ({ before, at }) => {
      let retired = 0;
      for (const record of records.values()) {
        if (record.phase === 'finished') continue;
        if (record.lastHeartbeatAt >= before) continue;
        const applied = await (async () => {
          const current = records.get(record.executionId);
          if (!current || current.phase === 'finished') return null;
          const next: ExecutionRecord = {
            ...current,
            phase: 'finished',
            cause: 'interrupted',
            lastHeartbeatAt: at,
            finishedAt: at,
            termination: {
              status: 'unverified',
              reason: 'adapter_did_not_report',
              observedAt: at,
              detail: 'The process that owned this execution stopped heartbeating.',
            },
            capabilityRevokedAt: at,
          };
          records.set(record.executionId, next);
          return next;
        })();
        if (applied) retired += 1;
      }
      return retired;
    },
  };
}
