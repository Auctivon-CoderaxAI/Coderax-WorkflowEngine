import type { Usage } from '@coderax/contracts';
import type {
  BudgetReservationRecord,
  BudgetStore,
  BudgetSnapshot,
  ReserveBudgetResult,
} from './budgets.js';
import type { MongoCollectionLike } from './mongo.js';
import { isDuplicateKey } from './mongo.js';

/**
 * Mongo-backed reservation counters.
 *
 * Reservation rows and day counters are separate so the day row stays a small
 * document even after a busy day. `reserve` inserts the reservation first and
 * then applies one conditional `$inc`; if the condition fails the row is
 * removed. A crash between the two steps leaves an unused reservation row, which
 * is harmless and is cleaned by the budget retention window.
 */
export async function ensureBudgetIndexes(input: {
  days: MongoCollectionLike;
  reservations: MongoCollectionLike;
}): Promise<void> {
  await input.days.createIndex(
    { ownerId: 1, day: 1 },
    { unique: true, name: 'budget_day_owner' },
  );
  await input.reservations.createIndex(
    { id: 1 },
    { unique: true, name: 'budget_reservation_id' },
  );
  await input.reservations.createIndex(
    { ownerId: 1, day: 1 },
    { name: 'budget_reservation_owner_day' },
  );
}

function snapshotOf(document: Record<string, unknown> | null): BudgetSnapshot {
  return {
    requests: typeof document?.requests === 'number' ? document.requests : 0,
    inputTokens: typeof document?.inputTokens === 'number' ? document.inputTokens : 0,
    outputTokens: typeof document?.outputTokens === 'number' ? document.outputTokens : 0,
  };
}

export function createMongoBudgetStore(input: {
  days: MongoCollectionLike;
  reservations: MongoCollectionLike;
}): BudgetStore {
  async function readReservation(id: string): Promise<BudgetReservationRecord | null> {
    const document = await input.reservations.findOne({ id });
    if (!document || typeof document.ownerId !== 'string' || typeof document.day !== 'string') {
      return null;
    }
    return {
      id,
      ownerId: document.ownerId,
      day: document.day,
      inputTokens: typeof document.inputTokens === 'number' ? document.inputTokens : 0,
      outputTokens: typeof document.outputTokens === 'number' ? document.outputTokens : 0,
      state:
        document.state === 'settled' || document.state === 'released'
          ? document.state
          : 'reserved',
    };
  }

  async function snapshot(ownerId: string, day: string): Promise<BudgetSnapshot> {
    return snapshotOf(await input.days.findOne({ ownerId, day }));
  }

  async function adjust(
    ownerId: string,
    day: string,
    change: { requests?: number; inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    await input.days.updateOne(
      { ownerId, day },
      { $inc: change },
      { upsert: false },
    );
  }

  return {
    reserve: async ({ reservation, maxRequests, maxTokens }): Promise<ReserveBudgetResult> => {
      try {
        await input.reservations.insertOne({ ...reservation, state: 'reserved' });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        await readReservation(reservation.id);
        return { allowed: true, requests: (await snapshot(reservation.ownerId, reservation.day)).requests };
      }

      // The day row must exist before an `$expr` update can match it. Creating it
      // with `$setOnInsert` is safe under a race: the unique index rejects the
      // loser, which then simply continues with the winner's row.
      try {
        await input.days.updateOne(
          { ownerId: reservation.ownerId, day: reservation.day },
          {
            $setOnInsert: {
              ownerId: reservation.ownerId,
              day: reservation.day,
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
            },
          },
          { upsert: true },
        );
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }

      const result = await input.days.updateOne(
        {
          ownerId: reservation.ownerId,
          day: reservation.day,
          $expr: {
            $and: [
              { $lt: ['$requests', maxRequests] },
              {
                $lte: [
                  {
                    $add: [
                      '$inputTokens',
                      '$outputTokens',
                      reservation.inputTokens,
                      reservation.outputTokens,
                    ],
                  },
                  maxTokens,
                ],
              },
            ],
          },
        },
        {
          $inc: {
            requests: 1,
            inputTokens: reservation.inputTokens,
            outputTokens: reservation.outputTokens,
          },
        },
        { upsert: false },
      );

      if ((result.matchedCount ?? 0) === 0) {
        const current = await snapshot(reservation.ownerId, reservation.day);
        await input.reservations.deleteOne({ id: reservation.id, state: 'reserved' });
        return current.requests >= maxRequests
          ? { allowed: false, reason: 'requests', requests: current.requests }
          : { allowed: false, reason: 'tokens', requests: current.requests };
      }
      return {
        allowed: true,
        requests: (await snapshot(reservation.ownerId, reservation.day)).requests,
      };
    },

    settle: async (reservationId: string, usage: Usage) => {
      const updated = await input.reservations.findOneAndUpdate(
        { id: reservationId, state: 'reserved' },
        { $set: { state: 'settled' } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      if (!updated) return false;
      const reservation = await readReservation(reservationId);
      if (!reservation) return false;
      const actualIn = Math.max(0, usage.inputTokens ?? reservation.inputTokens);
      const actualOut = Math.max(0, usage.outputTokens ?? reservation.outputTokens);
      await adjust(reservation.ownerId, reservation.day, {
        inputTokens: actualIn - reservation.inputTokens,
        outputTokens: actualOut - reservation.outputTokens,
      });
      return true;
    },

    release: async (reservationId, options) => {
      const updated = await input.reservations.findOneAndUpdate(
        { id: reservationId, state: 'reserved' },
        { $set: { state: 'released' } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      if (!updated) return false;
      const reservation = await readReservation(reservationId);
      if (!reservation) return false;
      await adjust(reservation.ownerId, reservation.day, {
        ...(options.dispatched ? {} : { requests: -1 }),
        inputTokens: -reservation.inputTokens,
        outputTokens: -reservation.outputTokens,
      });
      // Final, unlike settle: a deterministic id that is admitted again must
      // pass the conditional reserve instead of matching a released row.
      await input.reservations.deleteOne({ id: reservationId, state: 'released' });
      return true;
    },

    snapshot,
  };
}
