import type { BudgetWindow, BudgetWindowStore } from '../models/budget.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * The durable quota window: one row per owner per UTC day.
 *
 * `reserve` puts the ceiling inside the update filter and increments in the same
 * operation, so two replicas racing for the last request cannot both succeed.
 * MongoDB cannot upsert-and-conditionally-fail atomically, so the sequence is:
 * conditional update; on no match, insert the first row; on a duplicate-key race,
 * retry the conditional update. That leaves exactly one winner per slot.
 *
 * Settlement and release push their reservation id into the same window row and
 * exclude an id already present. One atomic document update therefore applies a
 * given reservation exactly once, even when two replicas settle it concurrently.
 */

type Row = {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reservedTokens: number;
  /** reservedTokens + inputTokens + outputTokens, maintained on every write. */
  committed: number;
  settledIds?: string[];
  releasedIds?: string[];
};

function toWindow(row: Row | null): BudgetWindow {
  if (!row) return { requests: 0, inputTokens: 0, outputTokens: 0, reservedTokens: 0 };
  return {
    requests: Number(row.requests ?? 0),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    reservedTokens: Number(row.reservedTokens ?? 0),
  };
}

function duplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

export function createMongoBudgetStore(collection: MongoCollectionLike): BudgetWindowStore {
  async function conditionalIncrement(
    key: string,
    maxRequests: number,
    maxTokens: number,
    tokens: number,
  ): Promise<BudgetWindow | null> {
    const changed = await collection.findOneAndUpdate(
      {
        key,
        requests: { $lt: maxRequests },
        // Reserved plus already-spent tokens must stay under the ceiling.
        committed: { $lte: maxTokens - tokens },
      },
      { $inc: { requests: 1, reservedTokens: tokens, committed: tokens } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    return changed ? toWindow(changed as unknown as Row) : null;
  }

  return {
    reserve: async ({ key, maxRequests, maxTokens, tokens }) => {
      const incremented = await conditionalIncrement(key, maxRequests, maxTokens, tokens);
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
          reservedTokens: tokens,
          committed: tokens,
          settledIds: [],
          releasedIds: [],
        });
        return {
          allowed: true,
          window: { requests: 1, inputTokens: 0, outputTokens: 0, reservedTokens: tokens },
        };
      } catch (error) {
        if (!duplicateKey(error)) throw error;
        const raced = await conditionalIncrement(key, maxRequests, maxTokens, tokens);
        if (raced) return { allowed: true, window: raced };
        const current = await collection.findOne({ key });
        return { allowed: false, window: toWindow(current as unknown as Row) };
      }
    },

    settle: async ({
      key, reservationId, reservedTokens, reservedInputTokens, reservedOutputTokens, usage,
    }) => {
      // Missing usage falls back to the reservation: zero would refund tokens
      // the provider may already have consumed.
      const input = Math.max(0, usage.inputTokens ?? reservedInputTokens);
      const output = Math.max(0, usage.outputTokens ?? reservedOutputTokens);
      const released = Math.max(0, reservedTokens);
      const applied = await collection.findOneAndUpdate(
        {
          key,
          settledIds: { $ne: reservationId },
          releasedIds: { $ne: reservationId },
        },
        {
          $inc: {
            reservedTokens: -released,
            inputTokens: input,
            outputTokens: output,
            committed: input + output - released,
          },
          $push: { settledIds: reservationId },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return applied !== null;
    },

    release: async ({ key, reservationId, reservedTokens, dispatched }) => {
      const released = Math.max(0, reservedTokens);
      const applied = await collection.findOneAndUpdate(
        {
          key,
          settledIds: { $ne: reservationId },
          releasedIds: { $ne: reservationId },
        },
        {
          $inc: {
            reservedTokens: -released,
            committed: -released,
            // A reservation already spent the request slot; a never-dispatched
            // attempt returns it.
            ...(dispatched ? {} : { requests: -1 }),
          },
          $push: { releasedIds: reservationId },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return applied !== null;
    },

    read: async (key) => {
      const row = await collection.findOne({ key });
      return toWindow(row as unknown as Row | null);
    },
  };
}

export function budgetCollectionName(prefix: string): string {
  return `${prefix}budget_windows`;
}

export async function ensureBudgetIndexes(collection: MongoCollectionLike): Promise<void> {
  await collection.createIndex({ key: 1 }, { unique: true, name: 'budget_window' });
}
