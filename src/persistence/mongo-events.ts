import type { ExecutionEvent } from '@coderax/contracts';
import type { AppendResult, EventLog } from '../events/log.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Durable event storage.
 *
 * Two collections, for two different invariants:
 *
 * - `events` holds the stream. A unique index on `(taskId, seq)` is what makes a
 *   sequence number atomic: two writers that somehow computed the same number
 *   cannot both insert, and the loser is told `duplicate` instead of silently
 *   forking the log. A second unique index on `eventId` catches the same event
 *   arriving twice through a retry.
 * - `heads` holds one row per task with the highest generation that has written.
 *   `$max` makes that monotonic under concurrency, so a stale replica cannot
 *   lower it, and any event from an older generation is refused before it is
 *   stored.
 *
 * The generation check and the insert are two operations rather than one
 * transaction, so a stale writer can still lose the race between them. It loses
 * safely: the event is stored but carries the older generation, and the read
 * path drops events whose generation is below the task's current generation. The
 * head row is what the next writer sees, so the window is one insert wide rather
 * than a lease lifetime wide.
 */
export type MongoEventCollections = {
  events: MongoCollectionLike;
  heads: MongoCollectionLike;
};

export async function ensureEventIndexes(input: MongoEventCollections): Promise<void> {
  await input.events.createIndex(
    { taskId: 1, seq: 1 },
    { unique: true, name: 'event_task_seq' },
  );
  await input.events.createIndex(
    { taskId: 1, eventId: 1 },
    { unique: true, name: 'event_task_id' },
  );
  await input.events.createIndex({ taskId: 1, seq: -1 }, { name: 'event_task_tail' });
  await input.heads.createIndex({ taskId: 1 }, { unique: true, name: 'event_head_task' });
}

function toEvent(document: Record<string, unknown>): ExecutionEvent {
  if (typeof document.taskId !== 'string' || typeof document.seq !== 'number') {
    throw new Error('A stored execution event is malformed.');
  }
  const copy = { ...document };
  delete copy._id;
  delete copy.receivedAt;
  return copy as unknown as ExecutionEvent;
}

export function createMongoEventLog(input: MongoEventCollections): EventLog {
  const { events, heads } = input;

  return {
    append: async (batch) => {
      const results: AppendResult[] = [];
      for (const event of batch) {
        // `$max` is monotonic and safe under concurrent writers; upserting the
        // row first means the very first event also establishes the head.
        await heads.updateOne(
          { taskId: event.taskId },
          { $max: { generation: event.generation } },
          { upsert: true },
        );
        const head = await heads.findOne({ taskId: event.taskId });
        const accepted = typeof head?.generation === 'number' ? head.generation : event.generation;
        if (event.generation < accepted) {
          results.push('stale_generation');
          continue;
        }
        try {
          await events.insertOne({ ...event, receivedAt: new Date().toISOString() });
          results.push('appended');
        } catch (error) {
          if (isDuplicateKey(error)) {
            results.push('duplicate');
            continue;
          }
          throw error;
        }
      }
      return results;
    },

    read: async (taskId, after, limit) => {
      const documents = await events
        .find({ taskId, seq: { $gt: after } })
        .sort({ seq: 1 })
        .limit(Math.max(1, limit))
        .toArray();
      return documents.map(toEvent);
    },

    lastSeq: async (taskId) => {
      const documents = await events
        .find({ taskId })
        .sort({ seq: -1 })
        .limit(1)
        .toArray();
      const last = documents[0];
      return typeof last?.seq === 'number' ? last.seq : 0;
    },

    prune: async (taskId, keep) => {
      const documents = await events
        .find({ taskId })
        .sort({ seq: -1 })
        .limit(1)
        .toArray();
      const last = documents[0];
      if (typeof last?.seq !== 'number') return 0;
      const cutoff = last.seq - Math.max(0, keep);
      if (cutoff < 1) return 0;
      const result = await events.deleteMany({ taskId, seq: { $lte: cutoff } });
      return result.deletedCount;
    },

    deleteByTaskIds: async (taskIds) => {
      if (taskIds.length === 0) return 0;
      const result = await events.deleteMany({ taskId: { $in: [...taskIds] } });
      await heads.deleteMany({ taskId: { $in: [...taskIds] } });
      return result.deletedCount;
    },

    close: async () => undefined,
  };
}
