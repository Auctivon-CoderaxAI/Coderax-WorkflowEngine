import type { BudgetStore, BudgetWindow } from '../models/budget.js';
import { budgetKey } from '../models/budget.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * The durable budget window: one row per owner per UTC day.
 *
 * `reserve` puts the ceiling inside the update filter and increments in the same
 * operation, so two replicas racing for the last request cannot both succeed.
 * MongoDB cannot upsert-and-conditionally-fail atomically, so the sequence is:
 * conditional update; on no match, insert the first row; on a duplicate-key race,
 * retry the conditional update. That leaves exactly one winner per slot.
 */

type Row = {
  key: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reservedTokens: number;
  /**
   * reservedTokens + inputTokens + outputTokens, maintained on every write. A
   * single stored ceiling comparison is what makes the reservation atomic without
   * an aggregation expression in the update filter.
   */
  committed: number;
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

export function createMongoBudgetStore(collection: MongoCollectionLike): BudgetStore {
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

    settle: async ({ key, reservedTokens, usage }) => {
      const input = Math.max(0, usage.inputTokens ?? 0);
      const output = Math.max(0, usage.outputTokens ?? 0);
      const released = Math.max(0, reservedTokens);
      // A settlement without a prior row still counts; `upsert` keeps usage from
      // a resumed process visible instead of silently dropped.
      await collection.updateOne(
        { key },
        {
          $inc: {
            reservedTokens: -released,
            inputTokens: input,
            outputTokens: output,
            committed: input + output - released,
          },
        },
        { upsert: true },
      );
      // The decrement can overshoot only if a reservation was already settled;
      // clamp it so the reserved counter never goes negative.
      await collection.updateOne(
        { key, reservedTokens: { $lt: 0 } },
        { $set: { reservedTokens: 0 } },
        { upsert: false },
      );
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

export { budgetKey };
