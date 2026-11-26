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
 * - `heads` records the last accepted sequence, generation and event identity.
 *   A compare-and-set against that watermark fences concurrent appends.
 *
 * A row starts provisional. The head names the accepted row before it is
 * made visible. Readers and subsequent writers finish that transition after
 * a crash; failed compensation therefore cannot expose a rejected row.
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
  delete copy.provisional;
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

  // Existing installations stored committed events without a marker.
  const committed = { provisional: { $nin: [true] } };

  async function head(taskId: string): Promise<EventWatermark> {
    const row = await heads.findOne({ taskId });
    if (row && typeof row.eventId === 'string') {
      await events.updateOne(
        { taskId, seq: row.seq, eventId: row.eventId, provisional: true },
        { $set: { provisional: false } }, { upsert: false },
      );
    }
    return toWatermark(row);
  }

  async function reconcile(taskId: string): Promise<EventWatermark> {
    const current = await head(taskId);
    const rows = events.find({ taskId, ...committed });
    const newest = (await rows.sort({ seq: -1 }).limit(1).toArray())[0];
    // Committed generations and sequences advance together under the fence.
    const stored = toWatermark(newest ?? null);
    if (stored.seq > current.seq || stored.generation > current.generation) {
      await heads.updateOne({ taskId }, {
        $max: { seq: stored.seq, generation: stored.generation }, $setOnInsert: { taskId },
      }, { upsert: true });
      return head(taskId);
    }
    return current;
  }

  return {
    append: async (event): Promise<EventAppendOutcome> => {
      const { taskId, eventId, seq, generation } = event;
      let current = await reconcile(taskId);
      if (generation < current.generation) return { appended: false, reason: 'stale_generation' };
      if (seq <= current.seq) return { appended: false, reason: 'out_of_order' };

      try {
        await events.insertOne({ ...event, provisional: true });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // The sequence and the id are both unique: an existing row with this id
        // is the same event redelivered, anything else is a stale sequence.
        const sameId = await events.findOne({ taskId: event.taskId, eventId: event.eventId });
        return { appended: false, reason: sameId && sameId.provisional !== true ? 'duplicate' : 'out_of_order' };
      }

      while (current.seq < seq && current.generation <= generation) {
        // Compare both fields: the previous winner must be visible before its
        // identity can be replaced. A racing writer forces another head read.
        try {
          const changed = await heads.updateOne({ taskId, ...current }, {
            $set: { taskId, seq, generation, eventId },
          }, { upsert: current.seq === 0 && current.generation === 0 });
          if (changed.matchedCount || changed.upsertedCount) break;
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
        }
        current = await head(taskId);
      }
      if (current.seq >= seq || current.generation > generation) {
        await events.deleteOne({ taskId, eventId, provisional: true }).catch(() => undefined);
        return { appended: false, reason: current.generation > generation ? 'stale_generation' : 'out_of_order' };
      }
      await events.updateOne({ taskId, eventId, provisional: true },
        { $set: { provisional: false } }, { upsert: false });
      return { appended: true };
    },

    read: async ({ taskId, after, limit }): Promise<StoredReplay> => {
      await head(taskId);
      const bounded = Math.max(1, Math.floor(limit));
      const documents = await events
        .find({ taskId, ...committed, seq: { $gt: after } })
        .sort({ seq: 1 })
        .limit(bounded + 1)
        .toArray();
      const truncated = documents.length > bounded;
      const page = (truncated ? documents.slice(0, bounded) : documents).map(toEvent);
      const first = await events.find({ taskId, ...committed }).sort({ seq: 1 }).limit(1).toArray();
      const oldest = first[0]?.seq;
      return {
        events: page,
        hasMore: truncated,
        truncated: typeof oldest === 'number' && oldest > after + 1,
      };
    },

    watermark: async (taskId) => {
      const current = await reconcile(taskId);
      // Even an abandoned reservation occupies its unique seq. Skip the slot
      // without accepting its generation or making it visible to readers.
      const [reserved] = await events.find({ taskId }).sort({ seq: -1 }).limit(1).toArray();
      return { ...current, seq: Math.max(current.seq, Number(reserved?.seq ?? 0)) };
    },

    latest: async (taskId, limit) => {
      await head(taskId);
      const bounded = Math.max(1, Math.floor(limit));
      const documents = await events
        .find({ taskId, ...committed })
        .sort({ seq: -1 })
        .limit(bounded)
        .toArray();
      return documents.map(toEvent).reverse();
    },

    prune: async ({ before, limit }) => {
      const bounded = Math.max(1, Math.floor(limit));
      // Housekeeping metadata has no taskId; event heads always have one.
      const key = { kind: 'retention_cursor' };
      const saved = await heads.findOne(key);
      let scanTask = typeof saved?.scanTask === 'string' ? saved.scanTask : undefined;
      let scanSeq = Number(saved?.scanSeq ?? 0);
      const expired = { ...committed, at: { $lt: before } };
      let removed = 0;
      // Remember a stable (task, seq) position across bounded sweeps. A long
      // prefix of protected endings cannot consume every sweep forever.
      for (let scanned = 0; scanned < bounded * 2 && removed < bounded; scanned++) {
        let [row] = scanTask === undefined ? [] : await events.find({
          ...expired, taskId: scanTask, seq: { $gt: scanSeq },
        }).sort({ seq: 1 }).limit(1).toArray();
        if (!row) {
          const [next] = await events.find({
            ...expired, ...(scanTask === undefined ? {} : { taskId: { $gt: scanTask } }),
          }).sort({ taskId: 1 }).limit(1).toArray();
          if (!next) { scanTask = undefined; break; }
          [row] = await events.find({ ...expired, taskId: next.taskId }).sort({ seq: 1 }).limit(1).toArray();
          if (!row) continue;
        }
        scanTask = String(row.taskId);
        scanSeq = Number(row.seq);
        const newer = await events.findOne({ ...committed, taskId: scanTask, seq: { $gt: scanSeq } });
        if (newer) removed += (await events.deleteOne({
          ...committed, taskId: scanTask, seq: scanSeq, eventId: row.eventId,
        })).deletedCount;
      }
      await heads.updateOne(key, { $set: { ...key, scanTask: scanTask ?? null, scanSeq } }, { upsert: true });
      return removed;
    },

    close: async () => undefined,
  };
}
