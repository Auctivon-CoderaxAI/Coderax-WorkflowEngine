import type { BudgetStore, BudgetWindow } from '../models/budget.js';
import { budgetKey } from '../models/budget.js';
import type { MongoCollectionLike } from './mongo.js';

/**
 * The durable budget tables.
 *
 * `budget_windows` holds one row per owner-day and per task-day: four counters
 * plus a stored `committed` ceiling total. `budget_reservations` holds one row
 * per in-flight request, so settlement and release can be made idempotent and an
 * abandoned reservation can be refunded exactly once.
 *
 * A reservation is taken by a conditional atomic update:
 *
 *   findOneAndUpdate({ key, requests: { $lt: maxRequests },
 *                      committed: { $lte: maxTokens - tokens } },
 *                    { $inc: { requests: 1, reservedTokens: tokens,
 *                              committed: tokens } })
 *
 * MongoDB evaluates the filter and applies the increment as one operation on one
 * document, so two replicas racing for the last request of the day cannot both
 * match: the loser sees `requests = maxRequests` and is refused. The stored
 * `committed` field exists because an update filter cannot sum three fields; it
 * is incremented by the same `$inc` as the counters it summarizes.
 *
 * MongoDB cannot upsert-and-conditionally-fail atomically, so the first
 * reservation of a day is: conditional update; on no match, insert the first row
 * under the unique key index; on a duplicate-key race, retry the conditional
 * update. Exactly one caller wins that sequence.
 */

type WindowRow = {
  key?: unknown;
  requests?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reservedTokens?: unknown;
};

type ReservationRow = {
  id?: unknown;
  key?: unknown;
  taskKey?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  expiresAt?: unknown;
  settled?: unknown;
};

function toWindow(row: WindowRow | null): BudgetWindow {
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

/** The maximum number of expired reservations refunded by one reservation call. */
const EXPIRY_SWEEP_LIMIT = 25;

export function createMongoBudgetStore(input: {
  windows: MongoCollectionLike;
  reservations: MongoCollectionLike;
}): BudgetStore {
  const { windows, reservations } = input;

  async function increment(
    key: string,
    maxRequests: number,
    maxTokens: number,
    tokens: number,
  ): Promise<BudgetWindow | null> {
    const changed = await windows.findOneAndUpdate(
      {
        key,
        requests: { $lt: maxRequests },
        // `$lt` refuses a reached ceiling even for a zero-token reservation;
        // `$lte` alone would admit one more request with no headroom.
        committed: { $lt: maxTokens, $lte: maxTokens - tokens },
      },
      { $inc: { requests: 1, reservedTokens: tokens, committed: tokens } },
      { returnDocument: 'after', includeResultMetadata: false },
    );
    return changed ? toWindow(changed as WindowRow) : null;
  }

  async function take(
    key: string,
    maxRequests: number,
    maxTokens: number,
    tokens: number,
  ): Promise<BudgetWindow | null> {
    // A single request larger than the whole ceiling can never be admitted. The
    // insert path below creates the first row of a day unconditionally, so this
    // guard is what stops one oversized request from opening an over-budget day.
    if (maxRequests < 1 || tokens > maxTokens) return null;
    const incremented = await increment(key, maxRequests, maxTokens, tokens);
    if (incremented) return incremented;

    const existing = await windows.findOne({ key });
    if (existing) return null;

    try {
      await windows.insertOne({
        key,
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        reservedTokens: tokens,
        committed: tokens,
      });
      return { requests: 1, inputTokens: 0, outputTokens: 0, reservedTokens: tokens };
    } catch (error) {
      if (!duplicateKey(error)) throw error;
      return increment(key, maxRequests, maxTokens, tokens);
    }
  }

  async function refund(key: string, requests: number, tokens: number): Promise<void> {
    await windows.updateOne(
      { key },
      { $inc: { requests: -requests, reservedTokens: -tokens, committed: -tokens } },
      { upsert: false },
    );
    // A refund can only overshoot if a reservation was settled twice, which the
    // reservation row prevents. Clamp anyway so a corrupt counter cannot turn
    // into free allowance.
    await clampWindow(key);
  }

  async function clampWindow(key: string): Promise<void> {
    await windows.updateOne(
      { key, reservedTokens: { $lt: 0 } },
      { $set: { reservedTokens: 0 } },
      { upsert: false },
    );
    await windows.updateOne(
      { key, requests: { $lt: 0 } },
      { $set: { requests: 0 } },
      { upsert: false },
    );
  }

  async function chargeWindow(
    key: string,
    requests: number,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    await windows.updateOne(
      { key },
      {
        $inc: {
          requests,
          inputTokens,
          outputTokens,
          committed: inputTokens + outputTokens,
        },
      },
      { upsert: true },
    );
  }

  /**
   * Refund expired reservations before taking new ones. Only the caller that
   * flips `settled` refunds, so a reservation refunded here can never also be
   * settled by a late response.
   */
  async function expire(keys: readonly string[], now: Date): Promise<void> {
    for (const key of keys) {
      for (let swept = 0; swept < EXPIRY_SWEEP_LIMIT; swept += 1) {
        const expired = await reservations.findOne({
          key,
          settled: false,
          expiresAt: { $lte: now },
        });
        if (!expired) break;
        const id = String((expired as ReservationRow).id ?? '');
        if (id === '') break;
        const claimed = await reservations.updateOne(
          { id, settled: false },
          { $set: { settled: true, outcome: 'expired', settledAt: now } },
          { upsert: false },
        );
        if ((claimed.matchedCount ?? 0) !== 1) continue;
        const taskKey = (expired as ReservationRow).taskKey;
        const tokens =
          Number((expired as ReservationRow).inputTokens ?? 0) +
          Number((expired as ReservationRow).outputTokens ?? 0);
        await refund(key, 1, tokens);
        if (typeof taskKey === 'string') await refund(taskKey, 1, tokens);
        await reservations.deleteOne({ id, settled: true });
      }
    }
  }

  /** Claim a reservation for exactly one terminal transition. */
  async function claim(
    id: string,
    outcome: 'settled' | 'released',
    now: Date,
  ): Promise<ReservationRow | null> {
    const claimed = await reservations.updateOne(
      { id, settled: false },
      { $set: { settled: true, outcome, settledAt: now } },
      { upsert: false },
    );
    if ((claimed.matchedCount ?? 0) !== 1) return null;
    const row = await reservations.findOne({ id });
    return row ? (row as ReservationRow) : null;
  }

  return {
    reserve: async (request) => {
      const keys = request.taskKey === null ? [request.key] : [request.key, request.taskKey];
      await expire(keys, request.now);

      const tokens = request.inputTokens + request.outputTokens;
      const owner = await take(request.key, request.maxRequests, request.maxTokens, tokens);
      if (!owner) {
        const refused = toWindow(await windows.findOne({ key: request.key }));
        const requestsExhausted = refused.requests >= request.maxRequests;
        return {
          allowed: false,
          reason: requestsExhausted ? 'requests' : 'tokens',
          window: refused,
        };
      }

      if (request.taskKey !== null) {
        const task = await take(
          request.taskKey,
          request.taskMaxRequests,
          request.taskMaxTokens,
          tokens,
        );
        if (!task) {
          // Compensation: the owner slot was taken under a ceiling the task then
          // refused. An increase followed by a decrease is safe because the two
          // operations target the same row and no other caller can observe a
          // "taken" state that was already returned.
          await refund(request.key, 1, tokens);
          const current = await windows.findOne({ key: request.key });
          const used = toWindow(current);
          const exhausted =
            used.requests >= request.maxRequests ||
            used.inputTokens + used.outputTokens + used.reservedTokens +
              tokens >
              request.maxTokens;
          return {
            allowed: false,
            reason: exhausted ? 'tokens' : 'task_tokens',
            window: used,
          };
        }
      }

      await reservations.insertOne({
        id: request.id,
        key: request.key,
        taskKey: request.taskKey,
        inputTokens: request.inputTokens,
        outputTokens: request.outputTokens,
        expiresAt: new Date(request.expiresAt),
        settled: false,
        createdAt: request.now,
      });

      return {
        allowed: true,
        reservationId: request.id,
        window: toWindow(await windows.findOne({ key: request.key })),
        taskWindow:
          request.taskKey === null ? null : toWindow(await windows.findOne({ key: request.taskKey })),
      };
    },

    settle: async ({ id, usage, now }) => {
      const held = await claim(id, 'settled', now);
      if (!held) return;
      const reservedIn = Number(held.inputTokens ?? 0);
      const reservedOut = Number(held.outputTokens ?? 0);
      // A missing side of a provider report is charged at the reserved amount:
      // treating it as zero would refund allowance that may have been consumed.
      const input = Math.max(0, usage.inputTokens ?? reservedIn);
      const output = Math.max(0, usage.outputTokens ?? reservedOut);
      const key = String(held.key ?? '');
      const taskKey = held.taskKey;
      if (key !== '') {
        await windows.updateOne(
          { key },
          {
            $inc: {
              reservedTokens: -(reservedIn + reservedOut),
              inputTokens: input,
              outputTokens: output,
              committed: input + output - (reservedIn + reservedOut),
            },
          },
          { upsert: true },
        );
        await clampWindow(key);
      }
      if (typeof taskKey === 'string' && taskKey !== '') {
        await windows.updateOne(
          { key: taskKey },
          {
            $inc: {
              reservedTokens: -(reservedIn + reservedOut),
              inputTokens: input,
              outputTokens: output,
              committed: input + output - (reservedIn + reservedOut),
            },
          },
          { upsert: true },
        );
        await clampWindow(taskKey);
      }
      await reservations.deleteOne({ id, settled: true });
    },

    release: async ({ id, dispatched, now }) => {
      const held = await claim(id, 'released', now);
      if (!held) return;
      const reservedIn = Number(held.inputTokens ?? 0);
      const reservedOut = Number(held.outputTokens ?? 0);
      const tokens = reservedIn + reservedOut;
      const key = String(held.key ?? '');
      const taskKey = held.taskKey;
      if (!dispatched) {
        if (key !== '') await refund(key, 1, tokens);
        if (typeof taskKey === 'string' && taskKey !== '') await refund(taskKey, 1, tokens);
      } else {
        // The provider may have consumed inference. Charge the reserved amount
        // instead of refunding it, so a timing-out or silently failing endpoint
        // cannot be used to exceed the free allowance.
        for (const target of [key, typeof taskKey === 'string' ? taskKey : '']) {
          if (target === '') continue;
          await windows.updateOne(
            { key: target },
            {
              $inc: {
                reservedTokens: -tokens,
                inputTokens: reservedIn,
                outputTokens: reservedOut,
              },
            },
            { upsert: true },
          );
          await clampWindow(target);
        }
      }
      await reservations.deleteOne({ id, settled: true });
    },

    charge: async ({ key, requests, inputTokens, outputTokens }) => {
      await chargeWindow(key, requests, inputTokens, outputTokens);
    },

    read: async (key) => toWindow(await windows.findOne({ key })),
  };
}

export function budgetWindowCollection(prefix: string): string {
  return `${prefix}budget_windows`;
}

export function budgetReservationCollection(prefix: string): string {
  return `${prefix}budget_reservations`;
}

export async function ensureBudgetIndexes(input: {
  windows: MongoCollectionLike;
  reservations: MongoCollectionLike;
}): Promise<void> {
  await input.windows.createIndex({ key: 1 }, { unique: true, name: 'budget_window' });
  await input.reservations.createIndex({ id: 1 }, { unique: true, name: 'budget_reservation' });
  await input.reservations.createIndex(
    { key: 1, settled: 1, expiresAt: 1 },
    { name: 'budget_reservation_expiry' },
  );
}

export { budgetKey };
