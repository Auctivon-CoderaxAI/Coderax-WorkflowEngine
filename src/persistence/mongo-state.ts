import type { ExecutionEvent } from '@coderax/contracts';
import type { AppendOutcome, EventLog } from '../events/log.js';
import type { Clock } from '../support/clock.js';
import type { IdempotencyStore, Reservation, ReserveResult } from './idempotency.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * Durable submission keys and execution events.
 *
 * One database operation per contract method again: the unique key index decides
 * a concurrent reservation, and the unique `(taskId, seq)` index is what makes a
 * second writer on one sequence a conflict instead of a silent overwrite.
 */

type IdempotencyRow = {
  ownerId: string;
  key: string;
  taskId: string;
  expiresAt: Date | null;
};

function toReservation(document: Record<string, unknown>): IdempotencyRow {
  const { ownerId, key, taskId, expiresAt } = document;
  if (
    typeof ownerId !== 'string' ||
    typeof key !== 'string' ||
    typeof taskId !== 'string' ||
    (expiresAt !== null && !(expiresAt instanceof Date))
  ) {
    throw new Error('A stored idempotency row is malformed.');
  }
  return { ownerId, key, taskId, expiresAt };
}

export async function ensureIdempotencyIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex(
    { ownerId: 1, key: 1 },
    { unique: true, name: 'idempotency_partition' },
  );
  // A completed reservation removes itself; a pending one has no date yet, and
  // MongoDB's TTL monitor never expires a document whose field is not a Date.
  await collection.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: 'idempotency_expiry' },
  );
}

export function createMongoIdempotencyStore(input: {
  collection: MongoCollectionLike;
  clock: Clock;
  ttlMs?: number;
}): IdempotencyStore {
  const ttlMs = input.ttlMs ?? 86_400_000;
  const { collection } = input;

  return {
    reserve: async (request: Reservation): Promise<ReserveResult> => {
      const now = input.clock.now();
      try {
        await collection.insertOne({
          ownerId: request.ownerId,
          key: request.key,
          taskId: request.taskId,
          expiresAt: null,
        });
        return { ok: true };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }

      const document = await collection.findOne({
        ownerId: request.ownerId,
        key: request.key,
      });
      // Another replica released the key between the insert and this read. The
      // reservation is refused rather than guessed: a refusal cannot start a
      // second run, so it is the safe side of that race.
      if (!document) return { ok: false };
      const row = toReservation(document);
      if (row.expiresAt === null) return { ok: false };
      if (row.expiresAt.getTime() > now.getTime()) {
        return { ok: false, completedTaskId: row.taskId };
      }

      // Take over an expired entry only if it is still the row that was read.
      const replaced = await collection.findOneAndUpdate(
        {
          ownerId: request.ownerId,
          key: request.key,
          taskId: row.taskId,
          expiresAt: { $lte: now },
        },
        { $set: { taskId: request.taskId, expiresAt: null } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return replaced ? { ok: true } : { ok: false };
    },

    complete: async (request: Reservation): Promise<void> => {
      const now = input.clock.now();
      await collection.updateOne(
        { ownerId: request.ownerId, key: request.key, taskId: request.taskId },
        { $set: { expiresAt: new Date(now.getTime() + ttlMs) } },
        { upsert: false },
      );
    },

    release: async (request: Reservation): Promise<void> => {
      await collection.deleteOne({
        ownerId: request.ownerId,
        key: request.key,
        taskId: request.taskId,
      });
    },
  };
}

function toEvent(document: Record<string, unknown>): ExecutionEvent {
  const copy = { ...document };
  delete copy._id;
  return copy as unknown as ExecutionEvent;
}

export async function ensureEventIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex(
    { taskId: 1, eventId: 1 },
    { unique: true, name: 'event_id' },
  );
  await collection.createIndex({ taskId: 1, seq: 1 }, { unique: true, name: 'event_seq' });
}

export function createMongoEventLog(collection: MongoCollectionLike): EventLog {
  return {
    append: async (event: ExecutionEvent): Promise<AppendOutcome> => {
      try {
        await collection.insertOne({ ...event });
        return { stored: true };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      const existing = await collection.findOne({
        taskId: event.taskId,
        eventId: event.eventId,
      });
      return existing
        ? { stored: false, reason: 'duplicate' }
        : { stored: false, reason: 'conflict' };
    },

    read: async (taskId, after) => {
      const documents = await collection
        .find({ taskId, seq: { $gt: after } })
        .sort({ seq: 1 })
        .toArray();
      return documents.map(toEvent);
    },

    lastSeq: async (taskId) => {
      const documents = await collection.find({ taskId }).sort({ seq: -1 }).limit(1).toArray();
      const latest = documents[0]?.seq;
      return typeof latest === 'number' ? latest : 0;
    },
  };
}
