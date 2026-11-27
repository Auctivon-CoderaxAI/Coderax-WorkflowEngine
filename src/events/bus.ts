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

export function createEventBus(input: {
  store: EventStore;
  seq: SeqAuthority;
  /** How often a tail re-reads the log; there is no in-process push path. */
  pollMs: number;
  eventId: () => string;
  iso: () => string;
}): EventBus {
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
      // A duplicate here means the allocated sequence was already stored, which
      // only happens if the head lagged the log. Reporting it as unpublished is
      // honest: the caller must not treat this event as delivered.
      return (await input.store.append(event)) === 'stored' ? event : null;
    },

    accept: async (event) => {
      if (await input.store.has(event.eventId)) {
        return { accepted: false, reason: 'duplicate' };
      }
      if (event.seq <= (await input.store.lastSeq(event.taskId))) {
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

    lastSeq: (taskId) => input.store.lastSeq(taskId),
  };
}
