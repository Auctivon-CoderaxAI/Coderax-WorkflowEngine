import type { BudgetWindow, BudgetWindowStore } from '../models/budget.js';
import { isDuplicateKey } from './mongo.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * The durable quota window: one row per owner per UTC day.
 *
 * `reserve` puts the request ceiling inside the update filter and increments in
 * the same operation, so two replicas racing for the last request cannot both
 * succeed. MongoDB cannot upsert-and-conditionally-fail atomically, so the
 * sequence is: conditional update; on no match, insert the first row; on a
 * duplicate-key race, retry the conditional update. That leaves exactly one
 * winner per slot.
 *
 * Release pushes its reservation id into the same row and excludes an id already
 * present, so one atomic document update returns a slot exactly once even when
 * two replicas race the same release.
 */

type Row = {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** inputTokens + outputTokens, maintained on every usage write. */
  committed: number;
  releasedIds?: string[];
};

function toWindow(row: Row | null): BudgetWindow {
  if (!row) return { requests: 0, inputTokens: 0, outputTokens: 0, committed: 0 };
  return {
    requests: Number(row.requests ?? 0),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    committed: Number(row.committed ?? 0),
  };
}

export function createMongoBudgetStore(collection: MongoCollectionLike): BudgetWindowStore {
  async function conditionalIncrement(
    key: string,
    maxRequests: number,
    maxTokens: number,
  ): Promise<BudgetWindow | null> {
    const changed = await collection.findOneAndUpdate(
      {
        key,
        requests: { $lt: maxRequests },
        // Already-spent tokens must stay under the ceiling. The comparison is
        // strict, so a window exactly at the ceiling refuses the next request.
        committed: { $lt: maxTokens },
      },
      { $inc: { requests: 1 } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    return changed ? toWindow(changed as unknown as Row) : null;
  }

  return {
    reserve: async ({ key, maxRequests, maxTokens }) => {
      const incremented = await conditionalIncrement(key, maxRequests, maxTokens);
      if (incremented) return { allowed: true, window: incremented };

      const existing = await collection.findOne({ key });
      if (existing) {
        return { allowed: false, window: toWindow(existing as unknown as Row) };
      }

      try {
        await collection.insertOne({
          key,
          requests: 1,
          inputTokens: 0,
          outputTokens: 0,
          committed: 0,
          releasedIds: [],
        });
        return {
          allowed: true,
          window: { requests: 1, inputTokens: 0, outputTokens: 0, committed: 0 },
        };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        const raced = await conditionalIncrement(key, maxRequests, maxTokens);
        if (raced) return { allowed: true, window: raced };
        const current = await collection.findOne({ key });
        return { allowed: false, window: toWindow(current as unknown as Row) };
      }
    },

    release: async ({ key, reservationId }) => {
      const applied = await collection.findOneAndUpdate(
        {
          key,
          requests: { $gt: 0 },
          releasedIds: { $ne: reservationId },
        },
        {
          $inc: { requests: -1 },
          $push: { releasedIds: reservationId },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return applied !== null;
    },

    consume: async ({ key, inputTokens, outputTokens }) => {
      const input = Math.max(0, Math.ceil(inputTokens));
      const output = Math.max(0, Math.ceil(outputTokens));
      await collection.updateOne(
        { key },
        {
          $inc: {
            inputTokens: input,
            outputTokens: output,
            committed: input + output,
          },
        },
        { upsert: true },
      );
    },

    read: async (key) => {
      const row = await collection.findOne({ key });
      return toWindow(row as unknown as Row | null);
    },
  };
}

export async function ensureBudgetIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ key: 1 }, { unique: true, name: 'budget_window' });
}
