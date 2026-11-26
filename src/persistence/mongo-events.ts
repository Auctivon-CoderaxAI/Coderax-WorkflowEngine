import type { ExecutionEvent } from '@coderax/contracts';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';
import type { EventAppendOutcome, EventLog, EventWatermark, StoredReplay } from '../events/log.js';

/**
 * Durable execution events in MongoDB.
 *
 * Two collections, each with one job:
 *
 * - `events` holds the ordered stream. A unique `(taskId, seq)` index makes a
 *   sequence number atomic, and a unique `(taskId, eventId)` index catches a
 *   redelivery. Insert-then-check is safe because the indexes are the arbiter,
 *   not an application read.
 * - `heads` holds the highest sequence and generation per task. `$max` advances
 *   it, so a delayed replica can never lower a watermark, and the generation in
 *   the head is what refuses a write from a superseded run.
 *
 * The head is advanced after the insert. A newer generation that commits in
 * between is detected by re-reading the head; the stale row is then removed by
 * its own identity, so a stale-generation write is never observable after the
 * call returns. That compensation is the one place this store deletes an event,
 * and it is why `append` reports `stale_generation` instead of throwing.
 */

export type EventCollections = {
  events: MongoCollectionLike;
  heads: MongoCollectionLike;
};

export async function ensureEventIndexes(input: EventCollections): Promise<void> {
  await input.events.createIndex(
    { taskId: 1, seq: 1 },
    { unique: true, name: 'event_task_seq' },
  );
  await input.events.createIndex(
    { taskId: 1, eventId: 1 },
    { unique: true, name: 'event_task_id' },
  );
  await input.events.createIndex({ at: 1 }, { name: 'event_at' });
  await input.heads.createIndex({ taskId: 1 }, { unique: true, name: 'event_head_task' });
  await input.heads.createIndex({ generation: 1 }, { name: 'event_head_generation' });
}

function toEvent(document: Record<string, unknown>): ExecutionEvent {
  const copy = { ...document };
  delete copy._id;
  return copy as unknown as ExecutionEvent;
}

function toWatermark(document: Record<string, unknown> | null): EventWatermark {
  if (!document) return { seq: 0, generation: 0 };
  const seq = typeof document.seq === 'number' ? document.seq : 0;
  const generation = typeof document.generation === 'number' ? document.generation : 0;
  return { seq, generation };
}

export function createMongoEventLog(input: EventCollections): EventLog {
  const { events, heads } = input;

  async function head(taskId: string): Promise<EventWatermark | null> {
    return toWatermark(await heads.findOne({ taskId }));
  }

  async function advance(event: ExecutionEvent): Promise<void> {
    await heads.updateOne(
      { taskId: event.taskId },
      {
        $max: { seq: event.seq, generation: event.generation },
        $setOnInsert: { taskId: event.taskId },
      },
      { upsert: true },
    );
  }

  return {
    append: async (event): Promise<EventAppendOutcome> => {
      const current = await head(event.taskId);
      if (current && event.generation < current.generation) {
        return { appended: false, reason: 'stale_generation' };
      }
      if (current && event.seq <= current.seq) {
        return { appended: false, reason: 'out_of_order' };
      }

      try {
        await events.insertOne({ ...event });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // The sequence and the id are both unique: an existing row with this id
        // is the same event redelivered, anything else is a stale sequence.
        const sameId = await events.findOne({ taskId: event.taskId, eventId: event.eventId });
        return { appended: false, reason: sameId ? 'duplicate' : 'out_of_order' };
      }

      await advance(event);
      const settled = await head(event.taskId);
      if (settled && settled.generation > event.generation) {
        // A newer generation committed between the insert and the head update.
        await events
          .deleteOne({ taskId: event.taskId, eventId: event.eventId })
          .catch(() => undefined);
        return { appended: false, reason: 'stale_generation' };
      }
      return { appended: true };
    },

    read: async ({ taskId, after, limit }): Promise<StoredReplay> => {
      const bounded = Math.max(1, Math.floor(limit));
      const documents = await events
        .find({ taskId, seq: { $gt: after } })
        .sort({ seq: 1 })
        .limit(bounded + 1)
        .toArray();
      const truncated = documents.length > bounded;
      const page = (truncated ? documents.slice(0, bounded) : documents).map(toEvent);
      const first = await events.find({ taskId }).sort({ seq: 1 }).limit(1).toArray();
      const oldest = first[0]?.seq;
      return {
        events: page,
        truncated: truncated || (typeof oldest === 'number' && oldest > after + 1),
      };
    },

    watermark: async (taskId) => {
      const current = await head(taskId);
      return current ?? { seq: 0, generation: 0 };
    },

    latest: async (taskId, limit) => {
      const bounded = Math.max(1, Math.floor(limit));
      const documents = await events
        .find({ taskId })
        .sort({ seq: -1 })
        .limit(bounded)
        .toArray();
      return documents.map(toEvent).reverse();
    },

    prune: async ({ before, limit }) => {
      const bounded = Math.max(1, Math.floor(limit));
      const candidates = await events
        .find({ at: { $lt: before } })
        .sort({ at: 1 })
        .limit(bounded)
        .toArray();
      if (candidates.length === 0) return 0;

      // Never remove the newest event of a task: the terminal record is what a
      // reconnecting client replays. Retention trims history, not the ending.
      const newestByTask = new Map<string, number>();
      for (const taskId of new Set(candidates.map((document) => String(document.taskId)))) {
        const latest = await events
          .find({ taskId })
          .sort({ seq: -1 })
          .limit(1)
          .toArray();
        const seq = latest[0]?.seq;
        if (typeof seq === 'number') newestByTask.set(taskId, seq);
      }

      let removed = 0;
      for (const document of candidates) {
        const taskId = String(document.taskId);
        const seq = typeof document.seq === 'number' ? document.seq : 0;
        if (newestByTask.get(taskId) === seq) continue;
        const result = await events.deleteOne({
          taskId,
          eventId: String(document.eventId),
        });
        removed += result.deletedCount;
      }
      return removed;
    },

    close: async () => undefined,
  };
}
