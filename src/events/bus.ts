import type {
  AgentId,
  ExecutionEvent,
  ExecutionEventType,
} from '@coderax/contracts';
import { EVENT_SCHEMA_VERSION } from '@coderax/contracts';
import type { AppendResult, EventLog } from './log.js';

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
 * tie. Persistence is asynchronous because `publish` is called from inside an
 * adapter's report loop and must never block it. A coalescing timer stores the
 * pending batch shortly after it is published, so the stream is durable while
 * the run is still executing and another replica can replay it; `flush` is the
 * barrier the service awaits before it writes a terminal task state, so the
 * stream and the task record cannot disagree about whether a run finished.
 *
 * A bounded pending queue is deliberate: an adapter that emits faster than the
 * database accepts must lose intermediate `text.delta` events (the client has
 * `text.replace` and the task checkpoint) rather than grow memory without limit
 * or stall the run. Terminal events are never dropped.
 */
export type EventBus = {
  publish: (draft: EventDraft) => ExecutionEvent;
  /** Applies an externally produced event (recovery) exactly once. */
  accept: (event: ExecutionEvent) => AcceptResult;
  /** The in-process retained window; synchronous, used by tests and tailing. */
  replay: (taskId: string, after: number) => Replay;
  /** The durable stream, including events written by a previous process. */
  read: (taskId: string, after: number) => Promise<Replay>;
  subscribe: (taskId: string, after: number, listener: (event: ExecutionEvent) => void) => Unsubscribe;
  lastSeq: (taskId: string) => number;
  /** Loads the durable watermark so a resumed task continues after it. */
  hydrate: (taskId: string) => Promise<number>;
  /** Waits until everything published for the task is stored (or rejected). */
  flush: (taskId: string) => Promise<void>;
  /** Flushes every task; called before the process releases the database. */
  close: () => Promise<void>;
  /** Events dropped by backpressure, for health and tests. */
  dropped: () => number;
};

type Stream = {
  events: ExecutionEvent[];
  seq: number;
  seen: Set<string>;
  listeners: Set<{ cursor: number; listener: (event: ExecutionEvent) => void }>;
  pending: ExecutionEvent[];
  fenced: boolean;
  hydrated: Promise<number> | null;
};

const TERMINAL: ReadonlySet<ExecutionEventType> = new Set([
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
]);

export function createEventBus(input: {
  bufferSize: number;
  eventId: () => string;
  iso: () => string;
  log?: EventLog;
  /** Pending events held before the oldest deltas are dropped. */
  maxPending?: number;
  /** Events kept per task after a terminal flush. */
  retain?: number;
}): EventBus {
  const streams = new Map<string, Stream>();
  const flushing = new Map<string, Promise<void>>();
  const timers = new Map<string, NodeJS.Timeout>();
  const maxPending = Math.max(16, input.maxPending ?? 512);
  const retain = Math.max(1, input.retain ?? input.bufferSize);
  let dropped = 0;

  function stream(taskId: string): Stream {
    const existing = streams.get(taskId);
    if (existing) return existing;
    const created: Stream = {
      events: [],
      seq: 0,
      seen: new Set(),
      listeners: new Set(),
      pending: [],
      fenced: false,
      hydrated: null,
    };
    streams.set(taskId, created);
    return created;
  }

  function append(state: Stream, event: ExecutionEvent): void {
    state.events.push(event);
    state.seen.add(event.eventId);
    if (state.events.length > input.bufferSize) {
      state.events.splice(0, state.events.length - input.bufferSize);
    }
    for (const subscriber of state.listeners) {
      if (event.seq > subscriber.cursor) {
        subscriber.cursor = event.seq;
        subscriber.listener(event);
      }
    }
  }

  /** Drops the oldest non-terminal pending event; a terminal one is never lost. */
  function shed(state: Stream): boolean {
    const index = state.pending.findIndex((event) => !TERMINAL.has(event.type));
    if (index === -1) return false;
    state.pending.splice(index, 1);
    dropped += 1;
    return true;
  }

  async function hydrate(taskId: string): Promise<number> {
    const state = stream(taskId);
    if (!input.log) return state.seq;
    if (state.hydrated) return state.hydrated;
    state.hydrated = (async () => {
      const last = await input.log!.lastSeq(taskId);
      const advanced = last > state.seq;
      state.seq = Math.max(state.seq, last);
      if (!advanced) return state.seq;
      const recent = await input.log!.read(taskId, Math.max(0, last - input.bufferSize), input.bufferSize);
      for (const event of recent) {
        if (state.seen.has(event.eventId)) continue;
        state.events.push(event);
        state.seen.add(event.eventId);
      }
      if (state.events.length > input.bufferSize) {
        state.events.splice(0, state.events.length - input.bufferSize);
      }
      return state.seq;
    })();
    try {
      return await state.hydrated;
    } finally {
      // The watermark is a moving target: another replica keeps writing while
      // this one reads, so a cached result would report a watermark the replay
      // has already passed. A failed hydration also retries on the next call
      // instead of pinning the task to a stale sequence forever.
      state.hydrated = null;
    }
  }

  function cancelTimer(taskId: string): void {
    const timer = timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(taskId);
    }
  }

  /**
   * One timer per task coalesces a burst of deltas into a single write attempt
   * and keeps the stream durable between settlement points. The delay is only a
   * turn of the event loop: a synchronous burst still fills the bounded pending
   * queue, so backpressure is unchanged.
   */
  function schedule(taskId: string): void {
    if (!input.log || timers.has(taskId)) return;
    const timer = setTimeout(() => {
      timers.delete(taskId);
      void flushPending(taskId).catch(() => undefined);
    }, 0);
    timer.unref();
    timers.set(taskId, timer);
  }

  async function flushPending(taskId: string): Promise<void> {
    const running = flushing.get(taskId);
    if (running) return running;
    const state = streams.get(taskId);
    if (!state || !input.log || state.fenced) return;
    const run = (async () => {
      while (state.pending.length > 0 && !state.fenced) {
        const batch = state.pending.splice(0, 200);
        let results: AppendResult[];
        try {
          results = await input.log!.append(batch);
        } catch (error) {
          // Keep the batch queued; the log's unique indexes turn a repeated
          // insert into a duplicate, so a retry cannot fork the stream.
          state.pending.unshift(...batch);
          throw error;
        }
        if (results.includes('stale_generation')) {
          // This process no longer owns the task. Stop writing rather than
          // interleaving a superseded generation into the newer stream.
          state.fenced = true;
          state.pending.length = 0;
          return;
        }
      }
    })().finally(() => {
      flushing.delete(taskId);
    });
    flushing.set(taskId, run);
    return run;
  }

  /** The settlement barrier: everything published so far is stored. */
  async function drain(taskId: string): Promise<void> {
    cancelTimer(taskId);
    for (;;) {
      await flushPending(taskId);
      const state = streams.get(taskId);
      if (!state || !input.log || state.fenced || state.pending.length === 0) return;
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
      if (state.fenced) return event;
      append(state, event);
      state.pending.push(event);
      while (state.pending.length > maxPending) {
        if (!shed(state)) {
          // A queue of terminal events only means the database is very slow;
          // keep them and let flush try, rather than dropping a settlement.
          break;
        }
      }
      schedule(draft.taskId);
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
      state.pending.push(event);
      schedule(event.taskId);
      return { accepted: true, event };
    },

    replay: (taskId, after) => {
      const state = streams.get(taskId);
      if (!state) return { events: [], truncated: false };
      const oldest = state.events[0]?.seq ?? 0;
      if (oldest > 1 && after + 1 < oldest) {
        return { events: state.events, truncated: true };
      }
      return {
        events: state.events.filter((event) => event.seq > after),
        truncated: false,
      };
    },

    read: async (taskId, after) => {
      if (!input.log) return { events: [], truncated: false };
      await hydrate(taskId);
      const events = await input.log.read(taskId, after, input.bufferSize + 1);
      const window = events.slice(0, input.bufferSize);
      // Truncation is a gap, not just a full window: retention may have dropped
      // the events immediately after the caller's cursor.
      const gap = window.length > 0 && window[0]!.seq > after + 1;
      return {
        events: window,
        truncated: events.length > input.bufferSize || gap,
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

    hydrate,

    flush: async (taskId) => {
      await drain(taskId);
      const state = streams.get(taskId);
      if (!state || !input.log || state.fenced) return;
      const last = state.events.at(-1);
      if (last && TERMINAL.has(last.type)) {
        await input.log.prune(taskId, retain).catch(() => 0);
      }
    },

    close: async () => {
      for (const taskId of [...timers.keys()]) cancelTimer(taskId);
      await Promise.all([...streams.keys()].map((taskId) => drain(taskId)));
    },

    dropped: () => dropped,
  };
}
