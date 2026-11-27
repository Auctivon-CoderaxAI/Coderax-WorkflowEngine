import type { WorkRunRow, WorkRunTable } from './work-runs.js';

/**
 * Durable Work run leases in MongoDB.
 *
 * This is the production table. It implements the same contract as
 * `createInMemoryWorkRunTable`, but each method maps onto one atomic database
 * operation, so two replicas can race a claim and only one wins. The semantics
 * are deliberately identical to the verified `createWorkRunMethods` already used
 * by Coderax: claim takes over only an expired row, renewal and release require
 * the exact fencing token, and cancellation is a durable flag because the request
 * may land on a replica that is not running the task.
 *
 * The port is structural rather than a driver import: a `Collection` from the
 * official `mongodb` package satisfies it, and a test can satisfy it without a
 * server. That keeps this repository free of a runtime driver dependency while
 * still shipping real persistence code.
 */

export type MongoFilter = Record<string, unknown>;

/**
 * The update operators these tables rely on. `$inc` is how a capacity counter is
 * admitted atomically and how an event sequence is allocated: the filter and the
 * increment are one server-side operation, so two replicas cannot both spend the
 * last byte or hand out the same sequence. `$max` lets an adopted sequence raise
 * a head without ever lowering it.
 */
export type MongoUpdate = {
  $set?: Record<string, unknown>;
  $setOnInsert?: Record<string, unknown>;
  $inc?: Record<string, number>;
  /** Used by the blob read leases: the array and its count change together. */
  $push?: Record<string, unknown>;
  $pull?: Record<string, unknown>;
  $max?: Record<string, number>;
};

/** A lazily executed query; the subset of the driver cursor these stores use. */
export type MongoCursor = {
  sort: (spec: Record<string, 1 | -1>) => MongoCursor;
  limit: (value: number) => MongoCursor;
  toArray: () => Promise<Record<string, unknown>[]>;
};

/** The subset of the MongoDB collection API these tables need. */
export type MongoCollectionLike = {
  createIndex: (
    keys: Record<string, 1 | -1>,
    options?: {
      unique?: boolean;
      name?: string;
      partialFilterExpression?: MongoFilter;
      expireAfterSeconds?: number;
    },
  ) => Promise<unknown>;
  insertOne: (document: Record<string, unknown>) => Promise<unknown>;
  findOne: (filter: MongoFilter) => Promise<Record<string, unknown> | null>;
  findOneAndUpdate: (
    filter: MongoFilter,
    update: {
      $set?: Record<string, unknown>;
      /** Atomic counters used by the durable quota windows. */
      $inc?: Record<string, number>;
      /** Reservation ids, which make settlement and release exactly-once. */
      $push?: Record<string, unknown>;
    },
    options: { returnDocument: 'after'; includeResultMetadata: false },
  ) => Promise<Record<string, unknown> | null>;
  updateOne: (
    filter: MongoFilter,
    update: {
      $set?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
      /** Atomic additive update used by quota counters. */
      $inc?: Record<string, number>;
      /** Monotonic update used by the event head; never lowers a value. */
      $max?: Record<string, unknown>;
      $inc?: Record<string, number>;
    },
    options: { upsert: boolean },
  ) => Promise<{ matchedCount?: number; upsertedCount?: number }>;
  deleteOne: (filter: MongoFilter) => Promise<{ deletedCount: number }>;
  deleteMany: (filter: MongoFilter) => Promise<{ deletedCount: number }>;
  countDocuments: (filter: MongoFilter) => Promise<number>;
  aggregate: (pipeline: Record<string, unknown>[]) => { toArray: () => Promise<Record<string, unknown>[]> };
  find: (filter: MongoFilter) => MongoCursor;
};

const DUPLICATE_KEY = 11000;

export function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY
  );
}

/**
 * A row that does not describe a lease is a corrupt row, not an absent one.
 * Reporting it as absent would let another replica claim a task that may still
 * be running, so this throws instead.
 */
function toRow(document: Record<string, unknown>): WorkRunRow {
  const { key, owner, token, cancelRequested, expiresAt } = document;
  if (
    typeof key !== 'string' ||
    typeof owner !== 'string' ||
    typeof token !== 'string' ||
    !(expiresAt instanceof Date)
  ) {
    throw new Error('A stored Work run row is malformed.');
  }
  return {
    key,
    owner,
    token,
    cancelRequested: cancelRequested === true,
    expiresAt,
  };
}

/**
 * The unique key index is the arbiter of a concurrent claim: two upserts that
 * both match no live row still resolve to one document, and the loser gets a
 * duplicate-key error that becomes `false`. The expiry index keeps the cleanup
 * sweep bounded.
 */
export async function ensureWorkRunIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ key: 1 }, { unique: true, name: 'work_run_key' });
  await collection.createIndex({ expiresAt: 1 }, { name: 'work_run_expires' });
}

export function createMongoWorkRunTable(collection: MongoCollectionLike): WorkRunTable {
  return {
    insertIfAbsent: async (row, now) => {
      try {
        await collection.updateOne(
          { key: row.key, expiresAt: { $lte: now } },
          {
            $set: {
              owner: row.owner,
              token: row.token,
              cancelRequested: row.cancelRequested,
              expiresAt: row.expiresAt,
            },
            $setOnInsert: { key: row.key },
          },
          { upsert: true },
        );
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) {
          return false;
        }
        throw error;
      }
    },

    find: async (key) => {
      const document = await collection.findOne({ key });
      return document ? toRow(document) : null;
    },

    updateExpiry: async ({ key, token, now, expiresAt }) => {
      const document = await collection.findOneAndUpdate(
        { key, token, expiresAt: { $gt: now } },
        { $set: { expiresAt } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return document ? toRow(document) : null;
    },

    deleteByToken: async (key, token) => {
      const result = await collection.deleteOne({ key, token });
      return result.deletedCount === 1;
    },

    flagCancel: async (key, now) => {
      const document = await collection.findOneAndUpdate(
        { key, expiresAt: { $gt: now } },
        { $set: { cancelRequested: true } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return document ? toRow(document) : null;
    },

    deleteExpired: async (key, now) => {
      const result = await collection.deleteOne({ key, expiresAt: { $lte: now } });
      return result.deletedCount === 1;
    },

    deleteExpiredBefore: async (before, limit) => {
      const bounded = Math.max(0, Math.floor(limit));
      if (bounded === 0) {
        return [];
      }
      const candidates = await collection
        .find({ expiresAt: { $lte: before } })
        .sort({ expiresAt: 1 })
        .limit(bounded)
        .toArray();
      const keys = candidates.map((document) => toRow(document).key);
      if (keys.length === 0) {
        return [];
      }
      // Re-check the expiry in the delete itself: a row that was renewed after
      // the select must survive the sweep.
      await collection.deleteMany({ key: { $in: keys }, expiresAt: { $lte: before } });
      const remaining = await collection
        .find({ key: { $in: keys } })
        .sort({ key: 1 })
        .limit(keys.length)
        .toArray();
      const stillPresent = new Set(remaining.map((document) => toRow(document).key));
      return keys.filter((key) => !stillPresent.has(key));
    },
  };
}
