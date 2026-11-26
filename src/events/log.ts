import type { ExecutionEvent } from '@coderax/contracts';

/**
 * The durable side of the execution event stream.
 *
 * The bus owns sequencing and delivery; this port only stores what the bus has
 * already ordered. Keeping the two apart is what lets the same bus code run on a
 * process-local log in tests and on MongoDB in a deployment without changing the
 * semantics a client observes.
 *
 * `append` is where generation fencing is enforced. A replica that lost its
 * lease, or a process that was superseded while it was still shutting down, must
 * not be able to add an event to a task a newer generation now owns. The log
 * therefore remembers the highest generation it has accepted per task and
 * refuses anything older.
 */
export type AppendResult = 'appended' | 'duplicate' | 'stale_generation';

export type EventLog = {
  append: (events: readonly ExecutionEvent[]) => Promise<AppendResult[]>;
  /** Events with `seq > after`, oldest first, at most `limit`. */
  read: (taskId: string, after: number, limit: number) => Promise<ExecutionEvent[]>;
  lastSeq: (taskId: string) => Promise<number>;
  /** Drops all but the newest `keep` events. Returns how many were removed. */
  prune: (taskId: string, keep: number) => Promise<number>;
  /** Authorized erasure for a deleted conversation. */
  deleteByTaskIds: (taskIds: readonly string[]) => Promise<number>;
  close: () => Promise<void>;
};

type MemoryStream = {
  events: ExecutionEvent[];
  ids: Set<string>;
  generation: number;
};

/**
 * Process-local log used when `persistence.driver` is `memory`.
 *
 * It enforces the same invariants as the Mongo log (monotonic sequence, unique
 * event id, generation fencing, bounded retention) so a test that passes here is
 * testing the bus contract rather than a shortcut.
 */
export function createMemoryEventLog(): EventLog {
  const streams = new Map<string, MemoryStream>();

  function stream(taskId: string): MemoryStream {
    const existing = streams.get(taskId);
    if (existing) return existing;
    const created: MemoryStream = { events: [], ids: new Set(), generation: 0 };
    streams.set(taskId, created);
    return created;
  }

  return {
    append: async (events) => {
      const results: AppendResult[] = [];
      for (const event of events) {
        const state = stream(event.taskId);
        if (event.generation < state.generation) {
          results.push('stale_generation');
          continue;
        }
        state.generation = Math.max(state.generation, event.generation);
        if (state.ids.has(event.eventId)) {
          results.push('duplicate');
          continue;
        }
        const last = state.events.at(-1);
        if (last && event.seq <= last.seq) {
          // The unique per-task sequence is the duplicate guard; a caller that
          // reuses one is rejected rather than allowed to fork the stream.
          results.push('duplicate');
          continue;
        }
        state.events.push(event);
        state.ids.add(event.eventId);
        results.push('appended');
      }
      return results;
    },

    read: async (taskId, after, limit) =>
      (streams.get(taskId)?.events ?? [])
        .filter((event) => event.seq > after)
        .slice(0, Math.max(1, limit)),

    lastSeq: async (taskId) => streams.get(taskId)?.events.at(-1)?.seq ?? 0,

    prune: async (taskId, keep) => {
      const state = streams.get(taskId);
      if (!state) return 0;
      const excess = state.events.length - Math.max(0, keep);
      if (excess <= 0) return 0;
      const removed = state.events.splice(0, excess);
      for (const event of removed) state.ids.delete(event.eventId);
      return removed.length;
    },

    deleteByTaskIds: async (taskIds) => {
      let deleted = 0;
      for (const taskId of taskIds) {
        const state = streams.get(taskId);
        if (state) {
          deleted += state.events.length;
          streams.delete(taskId);
        }
      }
      return deleted;
    },

    close: async () => undefined,
  };
}

export const EVENT_LOG_RETAIN_DEFAULT = 5_000;
