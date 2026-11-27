import type {
  AgentId,
  ExecutionEvent,
  ExecutionEventType,
} from '@coderax/contracts';
import { EVENT_SCHEMA_VERSION } from '@coderax/contracts';
import { redactValue } from '../observability/redact.js';
import type { EventStore, Replay } from './store.js';

export type { Replay } from './store.js';

export type EventDraft = {
  taskId: string;
  /**
   * The generation that asserts it may write this task. The sequence allocator
   * checks it against the fenced task row, so a superseded run publishes nothing
   * instead of appending to a log a newer generation now owns.
   */
  runToken: string;
  agent: AgentId;
  generation: number;
  type: ExecutionEventType;
  payload?: unknown;
  /** Defaults to the bus clock; a recovery replay supplies the original time. */
  at?: string;
};

export type AcceptResult =
  | { accepted: true; event: ExecutionEvent }
  | { accepted: false; reason: 'duplicate' | 'out_of_order' };

export type Unsubscribe = () => void;

/**
 * The fenced sequence authority the bus needs. `TaskRepository` satisfies it, and
 * a test can supply a smaller object without a database.
 */
export type SeqAuthority = {
  allocateSeq: (input: { taskId: string; token: string }) => Promise<number | null>;
  adoptSeq: (input: { taskId: string; seq: number }) => Promise<void>;
};

/**
 * One durable log per task, shared by every process that can reach the store.
 *
 * `seq` is allocated by the fenced task row and never by a caller, so two
 * producers on two replicas cannot create a tie and a stale generation cannot
 * create anything at all. A subscriber polls the log from its cursor instead of
 * listening to process memory, which is what makes a replay after a restart and a
 * tail from another replica the same mechanism. A subscriber that disconnects
 * does not stop the run: appending is independent of any listener.
 */
export type EventBus = {
  /** Returns `null` when the writer no longer holds the task's fencing token. */
  publish: (draft: EventDraft) => Promise<ExecutionEvent | null>;
  /** Applies an externally produced event (replay or recovery) exactly once. */
  accept: (event: ExecutionEvent) => Promise<AcceptResult>;
  replay: (taskId: string, after: number) => Promise<Replay>;
  subscribe: (taskId: string, after: number, listener: (event: ExecutionEvent) => void) => Unsubscribe;
  lastSeq: (taskId: string) => Promise<number>;
};

type Stream = {
  events: ExecutionEvent[];
  seq: number;
  seen: Set<string>;
  listeners: Set<{ cursor: number; listener: (event: ExecutionEvent) => void }>;
  pending: ExecutionEvent[];
  /** The highest generation this process was told it no longer owns. */
  fencedGeneration: number | null;
  hydrated: Promise<number> | null;
  /** Serializes flushes so a retry cannot interleave older and newer batches. */
  flushing: Promise<void> | null;
};

const TERMINAL: ReadonlySet<ExecutionEventType> = new Set([
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.interrupted',
]);

export function createEventBus(input: {
  store: EventStore;
  seq: SeqAuthority;
  /** How often a tail re-reads the log; there is no in-process push path. */
  pollMs: number;
  eventId: () => string;
  iso: () => string;
}): EventBus {
  const streams = new Map<string, Stream>();
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
      fencedGeneration: null,
      hydrated: null,
      flushing: null,
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
      state.seq = Math.max(state.seq, last);
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
    } catch (error) {
      // A failed hydration must not pin the task to a stale watermark; the next
      // call retries instead of publishing unverified sequence numbers forever.
      state.hydrated = null;
      throw error;
    }
  }

  async function flush(taskId: string): Promise<void> {
    const state = streams.get(taskId);
    if (!state || !input.log) return;
    if (state.flushing) return state.flushing;
    const run = (async () => {
      while (state.pending.length > 0) {
        const batch = state.pending.splice(0, 200);
        let results: Awaited<ReturnType<NonNullable<typeof input.log>['append']>>;
        try {
          results = await input.log!.append(batch);
        } catch (error) {
          // A failed append is not a lost append. Put the batch back ahead of
          // anything published while it was in flight; the next flush retries
          // in order, including terminal events.
          state.pending.unshift(...batch);
          throw error;
        }
        if (results.includes('stale_generation')) {
          // This process no longer owns these generations. Fence exactly them,
          // not the task forever: a resume in this process may legitimately
          // publish the next generation.
          const rejected = Math.max(...batch.map((event) => event.generation));
          state.fencedGeneration = Math.max(state.fencedGeneration ?? 0, rejected);
          state.pending.length = 0;
          return;
        }
      }
    })();
    // Do not clear this inside the async function: an empty flush resolves
    // synchronously, before this assignment, which would pin a fulfilled
    // promise and suppress every later flush.
    state.flushing = run;
    try {
      await run;
    } finally {
      if (state.flushing === run) state.flushing = null;
    }
  }

  return {
    publish: async (draft) => {
      const seq = await input.seq.allocateSeq({
        taskId: draft.taskId,
        token: draft.runToken,
      });
      if (seq === null) return null;
      const event = {
        v: EVENT_SCHEMA_VERSION,
        eventId: input.eventId(),
        taskId: draft.taskId,
        seq,
        at: draft.at || input.iso(),
        agent: draft.agent,
        generation: draft.generation,
        type: draft.type,
        // Redaction is enforced here, not by each producer: every event that is
        // streamed or persisted has already crossed this line.
        ...(draft.payload === undefined ? {} : { payload: redactValue(draft.payload) }),
      } as ExecutionEvent;
      if (state.fencedGeneration !== null) {
        if (draft.generation <= state.fencedGeneration) return event;
        // A newer generation re-claims the stream in this process.
        state.fencedGeneration = null;
      }
      append(state, event);
      state.pending.push(event);
      while (state.pending.length > maxPending) {
        if (!shed(state)) {
          // A queue of terminal events only means the database is very slow;
          // keep them and let flush try, rather than dropping a settlement.
          break;
        }
      }
      return event;
    },

    accept: async (event) => {
      if (await input.store.has(event.eventId)) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (state.fencedGeneration !== null) {
        if (event.generation <= state.fencedGeneration) {
          return { accepted: false, reason: 'out_of_order' };
        }
        state.fencedGeneration = null;
      }
      if (event.seq <= state.seq) {
        return { accepted: false, reason: 'out_of_order' };
      }
      // An adopted event crosses the same redaction boundary a published one
      // does: it is about to be stored and streamed like any other.
      const payload = (event as { payload?: unknown }).payload;
      const safe = (
        payload === undefined ? event : { ...event, payload: redactValue(payload) }
      ) as ExecutionEvent;
      if ((await input.store.append(safe)) === 'duplicate') {
        return { accepted: false, reason: 'duplicate' };
      }
      // Adoption raises the head so the next allocation continues above it; a
      // head that stayed behind would hand out a sequence the log already holds.
      await input.seq.adoptSeq({ taskId: event.taskId, seq: event.seq });
      return { accepted: true, event: safe };
    },

    replay: (taskId, after) => input.store.replay(taskId, after),

    subscribe: (taskId, after, listener) => {
      let cursor = after;
      let closed = false;
      let timer: NodeJS.Timeout | null = null;

      const poll = async (): Promise<void> => {
        try {
          const replay = await input.store.replay(taskId, cursor);
          for (const event of replay.events) {
            if (closed) return;
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            listener(event);
          }
        } catch {
          // The next poll re-reads from the same cursor, so a transient store
          // failure heals itself; a persistent one leaves the client to its own
          // timeout instead of ending a run that is still making progress.
        }
        schedule();
      };

      const schedule = (): void => {
        if (closed) return;
        timer = setTimeout(() => {
          void poll();
        }, input.pollMs);
        timer.unref();
      };

      schedule();
      return () => {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
      };
    },

    lastSeq: (taskId) => streams.get(taskId)?.seq ?? 0,

    hydrate,

    flush: async (taskId) => {
      await flush(taskId);
      const state = streams.get(taskId);
      if (!state || !input.log || state.fencedGeneration !== null) return;
      const last = state.events.at(-1);
      if (last && TERMINAL.has(last.type)) {
        await input.log.prune(taskId, retain).catch(() => 0);
      }
    },

    close: async () => {
      await Promise.all([...streams.keys()].map((taskId) => flush(taskId)));
    },

    dropped: () => dropped,
  };
}
