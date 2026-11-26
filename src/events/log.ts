import type { ExecutionEvent } from '@coderax/contracts';

/**
 * The durable ordered log behind the event bus.
 *
 * `seq` is per task and never restarts: a new generation continues the same
 * sequence, so a client cursor stays meaningful across a resume, a replica
 * change and a process restart. `generation` is part of the write and is
 * checked by the store, so a superseded run cannot append to the stream a newer
 * generation owns even if it still holds a reference to the bus.
 *
 * `append` is deliberately not "last write wins": it reports why a write was
 * refused so the caller can distinguish a redelivery from a fenced generation.
 */
export type EventAppendOutcome =
  | { appended: true }
  | { appended: false; reason: 'duplicate' | 'out_of_order' | 'stale_generation' };

export type StoredReplay = {
  events: ExecutionEvent[];
  /** True when events before the first returned one are no longer retained. */
  truncated: boolean;
  hasMore?: boolean;
};

export type EventWatermark = {
  seq: number;
  generation: number;
};

export type EventLog = {
  append: (event: ExecutionEvent) => Promise<EventAppendOutcome>;
  read: (input: { taskId: string; after: number; limit: number }) => Promise<StoredReplay>;
  /** The highest durable sequence and generation written for a task. */
  watermark: (taskId: string) => Promise<EventWatermark>;
  /**
   * The newest retained events in ascending order. A caller that only needs to
   * know how a stream ends (a repair checking for a terminal event, for example)
   * must not page from the beginning: a long stream would hide its ending.
   */
  latest: (taskId: string, limit: number) => Promise<ExecutionEvent[]>;
  /** Bounded retention sweep; never removes the newest event of a task. */
  prune: (input: { before: string; limit: number }) => Promise<number>;
  close: () => Promise<void>;
};

type InMemoryStream = {
  events: ExecutionEvent[];
  ids: Set<string>;
  seq: number;
  generation: number;
};

/**
 * A log with the durability of one process. It exists for the `memory` driver
 * and for tests that need a real log without a database; it is never described
 * as durable across a restart. It enforces the same ordering and fencing rules
 * as the database implementation, so behavior does not depend on the driver.
 */
export function createInMemoryEventLog(input: { bufferSize: number }): EventLog {
  const streams = new Map<string, InMemoryStream>();

  function stream(taskId: string): InMemoryStream {
    const existing = streams.get(taskId);
    if (existing) return existing;
    const created: InMemoryStream = { events: [], ids: new Set(), seq: 0, generation: 0 };
    streams.set(taskId, created);
    return created;
  }

  function trim(state: InMemoryStream): void {
    if (state.events.length > input.bufferSize) {
      const removed = state.events.splice(0, state.events.length - input.bufferSize);
      for (const event of removed) state.ids.delete(event.eventId);
    }
  }

  return {
    append: async (event) => {
      const state = stream(event.taskId);
      if (state.ids.has(event.eventId)) {
        return { appended: false, reason: 'duplicate' };
      }
      if (event.generation < state.generation) {
        return { appended: false, reason: 'stale_generation' };
      }
      if (event.seq <= state.seq) {
        return { appended: false, reason: 'out_of_order' };
      }
      state.seq = event.seq;
      state.generation = event.generation;
      state.events.push(event);
      state.ids.add(event.eventId);
      trim(state);
      return { appended: true };
    },

    read: async ({ taskId, after, limit }) => {
      const state = streams.get(taskId);
      if (!state) return { events: [], truncated: false };
      const bounded = Math.max(1, limit);
      const retained = state.events.filter((event) => event.seq > after);
      const oldest = state.events[0]?.seq ?? 0;
      // Same page shape as the database: the earliest events after the cursor,
      // and a flag when more remain or the head was already pruned.
      const truncated = state.events.length > 0 && oldest > after + 1;
      return { events: retained.slice(0, bounded), truncated, hasMore: retained.length > bounded };
    },

    watermark: async (taskId) => {
      const state = streams.get(taskId);
      return { seq: state?.seq ?? 0, generation: state?.generation ?? 0 };
    },

    latest: async (taskId, limit) => {
      const state = streams.get(taskId);
      if (!state) return [];
      return state.events.slice(-Math.max(1, limit));
    },

    prune: async ({ before, limit }) => {
      const cutoff = Date.parse(before);
      let removed = 0;
      for (const state of streams.values()) {
        if (removed >= limit) break;
        const newest = state.events[state.events.length - 1];
        const kept: ExecutionEvent[] = [];
        for (const event of state.events) {
          const expired = Number.isFinite(cutoff) && Date.parse(event.at) < cutoff;
          if (expired && event !== newest && removed < limit) {
            state.ids.delete(event.eventId);
            removed += 1;
            continue;
          }
          kept.push(event);
        }
        state.events = kept;
      }
      return removed;
    },

    close: async () => undefined,
  };
}
