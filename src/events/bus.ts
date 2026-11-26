import type {
  AgentId,
  ExecutionEvent,
  ExecutionEventType,
} from '@coderax/contracts';
import { EVENT_SCHEMA_VERSION } from '@coderax/contracts';
import type { EventLog, StoredReplay } from './log.js';

export type EventDraft = {
  taskId: string;
  agent: AgentId;
  generation: number;
  type: ExecutionEventType;
  payload?: unknown;
  /** Defaults to the bus clock; a recovery replay supplies the original time. */
  at?: string;
  /** Set for a derived repair so a redelivery of the same fact is idempotent. */
  eventId?: string;
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
 * A stream opened atomically: the subscription starts before the durable read,
 * and anything published while that read is in flight is buffered and delivered
 * by `subscribe` before live events. That closes the replay-to-subscribe gap: a
 * cursor is never advanced past an event the client did not receive.
 */
export type OpenedStream = {
  replay: Replay;
  subscribe: (listener: (event: ExecutionEvent) => void) => Unsubscribe;
  /** Releases the buffered subscription when the consumer never subscribes. */
  close: () => void;
};

/**
 * One bus per process, one ordered durable log per task.
 *
 * `seq` is assigned here and never by a caller, so two producers cannot create a
 * tie. It continues the durable watermark loaded by `hydrate`, so a restart does
 * not reset a client's cursor. Durable delivery follows append commit; process-local delivery is synchronous;
 * `flush` is the durability barrier, and settlement awaits it before announcing
 * a terminal state.
 *
 * A generation that is older than the watermark is refused (`publish` returns
 * `null`): a superseded run cannot append to the stream its successor owns.
 */
export type EventBus = {
  publish: (draft: EventDraft) => ExecutionEvent | null;
  /** Applies an externally produced event (replay or recovery) exactly once. */
  accept: (event: ExecutionEvent) => AcceptResult;
  /** In-process window; kept for synchronous inspection and existing callers. */
  replay: (taskId: string, after: number) => Replay;
  /** One ordered replay page, starting immediately after the cursor. */
  read: (taskId: string, after: number, limit?: number) => Promise<Replay>;
  /** Replay plus a subscription established before the read, with no gap. */
  open: (taskId: string, after: number, limit?: number) => Promise<OpenedStream>;
  subscribe: (taskId: string, after: number, listener: (event: ExecutionEvent) => void) => Unsubscribe;
  lastSeq: (taskId: string) => number;
  /** The newest events, oldest first; used to inspect how a stream ends. */
  tail: (taskId: string, limit: number) => Promise<ExecutionEvent[]>;
  /**
   * Loads the durable watermark before publishing. Pass the generation this
   * process is about to run: a newer generation re-reads the watermark, because
   * another replica may have advanced the sequence while this one was idle.
   */
  hydrate: (taskId: string, generation?: number) => Promise<void>;
  /** Waits for every append queued so far and rethrows the first failure. */
  flush: (taskId: string) => Promise<void>;
  /** Bounded retention sweep over the durable log. */
  prune: (input: { before: string; limit: number }) => Promise<number>;
  close: () => Promise<void>;
};

type Subscriber = {
  cursor: number;
  listener: ((event: ExecutionEvent) => void) | null;
  backlog: ExecutionEvent[];
};

type Stream = {
  events: ExecutionEvent[];
  seq: number;
  generation: number;
  seen: Set<string>;
  pending: Set<string>;
  listeners: Set<Subscriber>;
  /** Serialized durable appends; the tail is the flush barrier. */
  appends: Promise<void>;
  failure: Error | null;
  /** Cached watermark load, tagged with the generation it was read for. */
  hydrating: { generation: number; promise: Promise<void> } | null;
};

export function createEventBus(input: {
  bufferSize: number;
  eventId: () => string;
  iso: () => string;
  /** Absent means the bus is process-local; it is then never called durable. */
  log?: EventLog;
  processLocal?: boolean;
}): EventBus {
  const streams = new Map<string, Stream>();

  const tails = new Set<() => void>();

  function stream(taskId: string): Stream {
    const existing = streams.get(taskId);
    if (existing) return existing;
    const created: Stream = {
      events: [],
      seq: 0,
      generation: 0,
      seen: new Set(),
      pending: new Set(),
      listeners: new Set(),
      appends: Promise.resolve(),
      failure: null,
      hydrating: null,
    };
    streams.set(taskId, created);
    return created;
  }

  function deliver(state: Stream, event: ExecutionEvent): void {
    for (const subscriber of state.listeners) {
      if (event.seq <= subscriber.cursor) continue;
      subscriber.cursor = event.seq;
      if (subscriber.listener) subscriber.listener(event);
      else subscriber.backlog.push(event);
    }
  }

  function retain(state: Stream, event: ExecutionEvent): void {
    state.events.push(event);
    state.seen.add(event.eventId);
    if (state.events.length > input.bufferSize) {
      const removed = state.events.splice(0, state.events.length - input.bufferSize);
      for (const gone of removed) state.seen.delete(gone.eventId);
    }
    deliver(state, event);
  }

  function persist(state: Stream, event: ExecutionEvent): void {
    const log = input.log;
    if (!log || input.processLocal) retain(state, event);
    if (!log) return;
    state.pending.add(event.eventId);
    state.appends = state.appends
      .then(async () => {
        const outcome = await log.append(event);
        if (outcome.appended) {
          if (!input.processLocal) retain(state, event);
          return;
        }
        // A redelivery is already durable, so it is not a failure. Anything else
        // means this event will be missing from replay, and `flush` must report
        // it rather than let settlement announce a stream without its ending.
        if (outcome.reason === 'duplicate') return;
        state.failure ??= new Error(
          `event ${event.eventId} was not persisted (${outcome.reason})`,
        );
        if (outcome.reason === 'out_of_order') {
          // Another replica advanced the sequence past this process's cache.
          // Resynchronize so the remaining events of this generation are not
          // refused one after another, and force the next run to re-read.
          const watermark = await log.watermark(event.taskId).catch(() => null);
          if (watermark && watermark.seq > state.seq) state.seq = watermark.seq;
          state.hydrating = null;
        }
      })
      .catch((error: unknown) => {
        state.failure ??= error instanceof Error ? error : new Error(String(error));
      }).finally(() => { state.pending.delete(event.eventId); });
  }

  async function hydrate(taskId: string, generation?: number): Promise<void> {
    const state = stream(taskId);
    if (!input.log) return;
    // A cached load is only valid for the generation it was read for. Without
    // this, a replica that hydrated before another replica advanced the stream
    // would reuse sequence numbers its successor already owns.
    const needed = generation ?? 0;
    if (state.hydrating && state.hydrating.generation >= needed) {
      return state.hydrating.promise;
    }
    const running = (async () => {
      const watermark = await input.log?.watermark(taskId);
      if (!watermark) return;
      // A durable sequence is authoritative: never go backwards, even when this
      // process already published something locally.
      if (watermark.seq > state.seq) state.seq = watermark.seq;
      if (watermark.generation > state.generation) state.generation = watermark.generation;
    })().catch((error: unknown) => {
      // A failed hydration must be retryable; leaving a rejected promise cached
      // would make every later publish silently start from sequence zero.
      state.hydrating = null;
      throw error;
    });
    state.hydrating = { generation: needed, promise: running };
    return running;
  }

  /**
   * Drain a backlog larger than one page.
   *
   * `read` returns the earliest page so a cursor advances, and a fresh process
   * has no local buffer to supply the rest; stopping after one page would skip
   * the interval before the current watermark — including the terminal event.
   * Pages are bounded, and past the bound the newest window is kept so the
   * ending is always present and `truncated` says the head was dropped.
   */
  const MAX_REPLAY_PAGES = 64;
  async function readBacklog(
    taskId: string,
    after: number,
    pageSize: number,
  ): Promise<Replay> {
    let cursor = after;
    let events: ExecutionEvent[] = [];
    let dropped = false;
    for (let pages = 0; ; pages += 1) {
      const page = await readDurable(taskId, cursor, pageSize);
      dropped ||= page.truncated;
      const fresh = page.events.filter((event) => event.seq > cursor);
      if (fresh.length === 0) return { events, truncated: dropped || page.truncated };
      if (pages < MAX_REPLAY_PAGES) {
        events = [...events, ...fresh];
      } else {
        dropped = true;
        events = [...events, ...fresh].slice(-pageSize);
      }
      cursor = fresh[fresh.length - 1]?.seq ?? cursor;
      if (!page.hasMore) return { events, truncated: dropped };
    }
  }

  async function readDurable(taskId: string, after: number, limit?: number): Promise<StoredReplay> {
    const state = stream(taskId);
    await hydrate(taskId);
    if (!input.log) {
      const local = state.events.filter((event) => event.seq > after);
      const oldest = state.events[0]?.seq ?? 0;
      return {
        events: local,
        truncated: state.events.length > 0 && oldest > after + 1,
      };
    }
    if (input.processLocal) await state.appends;
    return input.log.read({
      taskId,
      after,
      limit: limit ?? input.bufferSize,
    });
  }

  return {
    publish: (draft) => {
      const state = stream(draft.taskId);
      // A superseded generation is refused before it consumes a sequence: a gap
      // in the stream must mean a dropped event, never a fenced one.
      if (draft.generation < state.generation) return null;

      state.seq += 1;
      state.generation = draft.generation;
      const event = {
        v: EVENT_SCHEMA_VERSION,
        eventId: draft.eventId ?? input.eventId(),
        taskId: draft.taskId,
        seq: state.seq,
        at: draft.at || input.iso(),
        agent: draft.agent,
        generation: draft.generation,
        type: draft.type,
        ...(draft.payload === undefined ? {} : { payload: draft.payload }),
      } as ExecutionEvent;
      persist(state, event);
      return event;
    },

    accept: (event) => {
      const state = stream(event.taskId);
      if (state.pending.has(event.eventId) || state.seen.has(event.eventId)) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (event.seq <= state.seq) {
        return { accepted: false, reason: 'out_of_order' };
      }
      if (event.generation < state.generation) {
        return { accepted: false, reason: 'out_of_order' };
      }
      state.seq = event.seq;
      state.generation = event.generation;
      persist(state, event);
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

    read: (taskId, after, limit) => readDurable(taskId, after, limit),

    open: async (taskId, after, limit) => {
      const state = stream(taskId);
      await hydrate(taskId);
      // Register at the client cursor: the local sequence may include pending appends.
      // The live cursor must never go below the cursor the client asked for: a
      // client that reconnected at 10 must not receive 6..9 from the tail.
      const subscriber: Subscriber = {
        cursor: after,
        listener: null,
        backlog: [],
      };
      state.listeners.add(subscriber);
      let replay: Replay;
      try {
        replay = await readBacklog(taskId, after, limit ?? input.bufferSize);
      } catch (error) {
        state.listeners.delete(subscriber);
        throw error;
      }
      // The replay already delivered everything up to its last sequence, so the
      // subscription must not deliver any of it a second time.
      const lastReplayed = replay.events[replay.events.length - 1]?.seq ?? 0;
      if (lastReplayed > subscriber.cursor) subscriber.cursor = lastReplayed;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const close = (): void => {
        closed = true;
        clearTimeout(timer);
        tails.delete(close);
        state.listeners.delete(subscriber);
      };
      return {
        replay,
        subscribe: (listener) => {
          // Runs to completion without awaiting, so draining the backlog and
          // going live cannot interleave with a publish. A buffered event a
          // later page already replayed is skipped, so a sequence is delivered
          // exactly once.
          let delivered = Math.max(after, lastReplayed);
          const durable = Boolean(input.log && !input.processLocal);
          const forward = (event: ExecutionEvent): void => {
            if (closed || event.seq <= delivered) return;
            delivered = event.seq;
            listener(event);
          };
          // A local append can follow an unseen remote append. Only fast-path
          // contiguous events; the ordered durable tail supplies any gap.
          const local = (event: ExecutionEvent): void => {
            if (!durable || event.seq === delivered + 1) forward(event);
          };
          for (const event of subscriber.backlog) local(event);
          subscriber.backlog.length = 0;
          subscriber.listener = local;
          if (durable) {
            const poll = async (): Promise<void> => {
              let more = false;
              try {
                const page = await readDurable(taskId, delivered, limit);
                for (const event of page.events) forward(event);
                more = Boolean(page.hasMore);
              } catch {
                // A temporary storage failure leaves the delivered cursor intact.
              }
              if (!closed) timer = setTimeout(poll, more ? 0 : 250).unref();
            };
            tails.add(close);
            void poll();
          }
          return close;
        },
        close,
      };
    },

    subscribe: (taskId, after, listener) => {
      const state = stream(taskId);
      const entry: Subscriber = { cursor: after, listener, backlog: [] };
      state.listeners.add(entry);
      return () => {
        state.listeners.delete(entry);
      };
    },

    lastSeq: (taskId) => streams.get(taskId)?.seq ?? 0,

    tail: async (taskId, limit) => {
      const state = stream(taskId);
      await hydrate(taskId);
      const bounded = Math.max(1, limit);
      const stored = input.log ? await input.log.latest(taskId, bounded) : [];
      const newest = stored[stored.length - 1]?.seq ?? 0;
      const local = state.events.filter((event) => event.seq > newest);
      return [...stored, ...local].sort((left, right) => left.seq - right.seq).slice(-bounded);
    },

    hydrate,

    flush: async (taskId) => {
      const state = streams.get(taskId);
      if (!state) return;
      await state.appends;
      if (state.failure) throw state.failure;
    },

    prune: async (range) => {
      const log = input.log;
      if (!log) return 0;
      return log.prune(range);
    },

    close: async () => {
      for (const close of tails) close();
      await Promise.allSettled([...streams.values()].map((state) => state.appends));
      await input.log?.close();
    },
  };
}
