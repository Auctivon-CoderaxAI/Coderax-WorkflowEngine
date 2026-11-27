import type { ExecutionEvent } from '@coderax/contracts';
import type { MongoCollectionLike } from '../persistence/mongo.js';
import { isDuplicateKey } from '../persistence/mongo.js';

/**
 * The durable execution log.
 *
 * One collection, one row per event, unique on `(taskId, seq)` and on `eventId`.
 * The sequence itself is not allocated here: it comes from the fenced task row,
 * because that is the only place where proving ownership and taking the next
 * number can be one atomic operation. This store only persists what the owner
 * allocated, and reads it back in sequence order.
 *
 * Appending is idempotent. A retried write after a lost acknowledgement hits the
 * unique index and is reported as a duplicate instead of raising, which is the
 * difference between a retry being safe and a retry silently forking the log.
 */
export type Replay = {
  events: ExecutionEvent[];
  /** True when at least one event between the cursor and the tail is gone. */
  truncated: boolean;
  /** The highest sequence the log holds for the task; 0 when it holds none. */
  lastSeq: number;
};

export type AppendResult = 'stored' | 'duplicate';

export type EventStore = {
  append: (event: ExecutionEvent) => Promise<AppendResult>;
  /** At most the configured page size, oldest first, strictly after `after`. */
  replay: (taskId: string, after: number) => Promise<Replay>;
  lastSeq: (taskId: string) => Promise<number>;
  /** Whether an event id is already stored, used to classify an adoption. */
  has: (eventId: string) => Promise<boolean>;
};

/**
 * A gap between the cursor and the first retained event means the consumer missed
 * something. A cursor ahead of the tail means the consumer outlived the log (a
 * different replica, or a task that was rewound) and must resync.
 */
export function isTruncated(input: {
  after: number;
  events: ExecutionEvent[];
  lastSeq: number;
}): boolean {
  if (input.after > input.lastSeq) return true;
  if (input.after === input.lastSeq) return false;
  return input.events[0]?.seq !== input.after + 1;
}

function bySeq(left: ExecutionEvent, right: ExecutionEvent): number {
  return left.seq - right.seq;
}

/**
 * The `memory` driver's log: the same contract with no durability, bounded by the
 * configured per-task size so a single process cannot grow without limit. It
 * keeps its own head because the retained window can start above 1, and a head
 * derived from the window would make a replayed cursor look like a reset.
 */
export function createMemoryEventStore(input: { maxPerTask: number }): EventStore {
  const logs = new Map<string, ExecutionEvent[]>();
  const heads = new Map<string, number>();
  const ids = new Set<string>();

  return {
    append: async (event) => {
      if (ids.has(event.eventId)) return 'duplicate';
      const log = logs.get(event.taskId) ?? [];
      if (log.some((entry) => entry.seq === event.seq)) return 'duplicate';
      log.push(event);
      log.sort(bySeq);
      ids.add(event.eventId);
      heads.set(event.taskId, Math.max(heads.get(event.taskId) ?? 0, event.seq));
      if (log.length > input.maxPerTask) {
        log.splice(0, log.length - input.maxPerTask);
      }
      logs.set(event.taskId, log);
      return 'stored';
    },

    replay: async (taskId, after) => {
      const events = (logs.get(taskId) ?? []).filter((entry) => entry.seq > after);
      const lastSeq = heads.get(taskId) ?? 0;
      return { events, truncated: isTruncated({ after, events, lastSeq }), lastSeq };
    },

    lastSeq: async (taskId) => heads.get(taskId) ?? 0,

    has: async (eventId) => ids.has(eventId),
  };
}

/** `storedAt` drives the TTL index; it is not part of the event contract. */
function toEvent(document: Record<string, unknown>): ExecutionEvent {
  const event = { ...document };
  delete event._id;
  delete event.storedAt;
  return event as unknown as ExecutionEvent;
}

/**
 * Two unique indexes and one TTL index.
 *
 * `(taskId, seq)` is the ordering guarantee and refuses a second event at a
 * sequence. `eventId` refuses the same event twice even if it arrives with a
 * different sequence. The TTL bound is the only truncation source, so a cursor
 * older than retention is reported rather than silently skipped.
 */
export async function ensureEventIndexes(
  collection: MongoCollectionLike,
  input: { retentionSeconds: number },
): Promise<void> {
  await collection.createIndex(
    { taskId: 1, seq: 1 },
    { unique: true, name: 'event_task_seq' },
  );
  await collection.createIndex({ eventId: 1 }, { unique: true, name: 'event_id' });
  await collection.createIndex(
    { storedAt: 1 },
    { name: 'event_retention', expireAfterSeconds: Math.max(0, Math.floor(input.retentionSeconds)) },
  );
}

export function createMongoEventStore(input: {
  collection: MongoCollectionLike;
  /** Bounds one replay read; the tail reads the rest on its next poll. */
  pageSize: number;
  now: () => Date;
}): EventStore {
  async function head(taskId: string): Promise<number> {
    const documents = await input.collection
      .find({ taskId })
      .sort({ seq: -1 })
      .limit(1)
      .toArray();
    const seq = documents[0]?.seq;
    return typeof seq === 'number' ? seq : 0;
  }

  return {
    append: async (event) => {
      try {
        await input.collection.insertOne({ ...event, storedAt: input.now() });
        return 'stored';
      } catch (error) {
        if (isDuplicateKey(error)) return 'duplicate';
        throw error;
      }
    },

    replay: async (taskId, after) => {
      const lastSeq = await head(taskId);
      const documents = await input.collection
        .find({ taskId, seq: { $gt: after } })
        .sort({ seq: 1 })
        .limit(input.pageSize)
        .toArray();
      const events = documents.map(toEvent);
      return { events, truncated: isTruncated({ after, events, lastSeq }), lastSeq };
    },

    lastSeq: head,

    has: async (eventId) => (await input.collection.findOne({ eventId })) !== null,
  };
}
