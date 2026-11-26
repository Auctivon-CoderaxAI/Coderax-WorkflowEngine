import type {
  AgentId,
  ExecutionEvent,
  ExecutionEventType,
} from '@coderax/contracts';
import { EVENT_SCHEMA_VERSION } from '@coderax/contracts';
import type { EventLog } from './log.js';

export type EventDraft = {
  taskId: string;
  agent: AgentId;
  generation: number;
  type: ExecutionEventType;
  payload?: unknown;
  /** Defaults to the bus clock; a recovery replay supplies the original time. */
  at?: string;
};

export type Replay = {
  events: ExecutionEvent[];
  /** True when the requested cursor is older than the retained window. */
  truncated: boolean;
};

export type AcceptResult =
  | { accepted: true; event: ExecutionEvent }
  | { accepted: false; reason: 'duplicate' | 'out_of_order' };

export type Unsubscribe = () => void;

/**
 * One bus per process, one ordered log per task.
 *
 * `seq` is assigned here and never by a caller, so two producers cannot create a
 * tie. A replayed event is accepted only when its id is new and its sequence is
 * beyond what has been seen; anything else is reported rather than applied. A
 * subscriber that disconnects does not stop the run: publishing is independent
 * of any listener.
 *
 * A durable `log` receives every published event. Writes are queued rather than
 * awaited so publishing stays synchronous for the runner; `flush` is what a
 * shutdown awaits before the connection closes, and it rethrows a write that
 * failed so lost history is never reported as stored.
 */
export type EventBus = {
  publish: (draft: EventDraft) => ExecutionEvent;
  /** Applies an externally produced event (replay or recovery) exactly once. */
  accept: (event: ExecutionEvent) => AcceptResult;
  replay: (taskId: string, after: number) => Replay;
  subscribe: (taskId: string, after: number, listener: (event: ExecutionEvent) => void) => Unsubscribe;
  lastSeq: (taskId: string) => number;
  /**
   * Continues numbering from history a previous process stored. Without this a
   * resumed run in a new process would publish `seq` 1 again over events that
   * already exist.
   */
  adopt: (taskId: string, seq: number) => void;
  /** Resolves once every published event has reached the durable log. */
  flush: () => Promise<void>;
};

type Stream = {
  events: ExecutionEvent[];
  seq: number;
  seen: Set<string>;
  listeners: Set<{ cursor: number; listener: (event: ExecutionEvent) => void }>;
};

export function createEventBus(input: {
  bufferSize: number;
  eventId: () => string;
  iso: () => string;
  log?: EventLog;
}): EventBus {
  const streams = new Map<string, Stream>();
  const pending = new Set<Promise<void>>();
  const failures: Error[] = [];

  function stream(taskId: string): Stream {
    const existing = streams.get(taskId);
    if (existing) return existing;
    const created: Stream = { events: [], seq: 0, seen: new Set(), listeners: new Set() };
    streams.set(taskId, created);
    return created;
  }

  function persist(event: ExecutionEvent): void {
    if (!input.log) return;
    const write = input.log.append(event).then(
      (outcome) => {
        if (!outcome.stored && outcome.reason === 'conflict') {
          failures.push(
            new Error(
              `Event ${event.eventId} collides with another event on ${event.taskId} seq ${event.seq}.`,
            ),
          );
        }
      },
      (error: unknown) => {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      },
    );
    pending.add(write);
    void write.then(() => pending.delete(write));
  }

  function append(state: Stream, event: ExecutionEvent): void {
    state.events.push(event);
    state.seen.add(event.eventId);
    if (state.events.length > input.bufferSize) {
      state.events.splice(0, state.events.length - input.bufferSize);
    }
    persist(event);
    for (const subscriber of state.listeners) {
      if (event.seq > subscriber.cursor) {
        subscriber.cursor = event.seq;
        subscriber.listener(event);
      }
    }
  }

  return {
    publish: (draft) => {
      const state = stream(draft.taskId);
      state.seq += 1;
      const event = {
        v: EVENT_SCHEMA_VERSION,
        eventId: input.eventId(),
        taskId: draft.taskId,
        seq: state.seq,
        at: draft.at || input.iso(),
        agent: draft.agent,
        generation: draft.generation,
        type: draft.type,
        ...(draft.payload === undefined ? {} : { payload: draft.payload }),
      } as ExecutionEvent;
      append(state, event);
      return event;
    },
    accept: (event) => {
      const state = stream(event.taskId);
      if (state.seen.has(event.eventId)) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (event.seq <= state.seq) {
        return { accepted: false, reason: 'out_of_order' };
      }
      state.seq = event.seq;
      append(state, event);
      return { accepted: true, event };
    },
    replay: (taskId, after) => {
      const state = streams.get(taskId);
      if (!state) return { events: [], truncated: false };
      const oldest = state.events[0]?.seq ?? 0;
      // The consumer's next needed sequence is `after + 1`; if that predates the
      // retained window, some events are gone and the caller must be told.
      if (oldest > 1 && after + 1 < oldest) {
        return { events: [...state.events], truncated: true };
      }
      return {
        events: state.events.filter((event) => event.seq > after),
        truncated: false,
      };
    },
    subscribe: (taskId, after, listener) => {
      const state = stream(taskId);
      const entry = { cursor: after, listener };
      state.listeners.add(entry);
      return () => {
        state.listeners.delete(entry);
      };
    },
    lastSeq: (taskId) => streams.get(taskId)?.seq ?? 0,
    adopt: (taskId, seq) => {
      if (seq <= 0) return;
      const state = stream(taskId);
      if (seq > state.seq) state.seq = seq;
    },
    flush: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
      const [failure] = failures.splice(0, failures.length);
      if (failure) throw failure;
    },
  };
}
