import type { Clock } from '../support/clock.js';

export type Reservation = { ownerId: string; key: string; taskId: string };
/** `pendingTaskId` names the in-flight submission a retry may be reconciled with. */
export type ReserveResult =
  | { ok: true }
  | { ok: false; completedTaskId?: string; pendingTaskId?: string };

/**
 * A key is reserved before the task exists and completed once it does, so a
 * concurrent retry is refused instead of starting a second run. Completion is
 * asynchronous because a durable store has to persist the task identity before
 * the submission is answered.
 */
export type IdempotencyStore = {
  reserve: (input: Reservation) => Promise<ReserveResult>;
  complete: (input: Reservation) => Promise<void>;
  release: (input: Reservation) => Promise<void>;
};

/**
 * Process-local reservations. `maxEntries` bounds the memory a single process
 * may spend; a database implementation is bounded by expiry instead.
 */
export function createIdempotencyStore(input: {
  clock: Clock;
  ttlMs?: number;
  maxEntries?: number;
}): IdempotencyStore {
  const ttlMs = input.ttlMs ?? 86_400_000;
  const maxEntries = input.maxEntries ?? 10_000;
  // A pending submission cannot safely expire while its create is in flight.
  const entries = new Map<string, { taskId: string; expiresAt: number | null }>();
  const partition = ({ ownerId, key }: Reservation) => JSON.stringify([ownerId, key]);

  return {
    reserve: async (request) => {
      const key = partition(request);
      const existing = entries.get(key);
      const now = input.clock.now().getTime();
      if (existing?.expiresAt === null) return { ok: false, pendingTaskId: existing.taskId };
      if (existing && existing.expiresAt > now) {
        return { ok: false, completedTaskId: existing.taskId };
      }
      entries.delete(key);
      if (entries.size >= maxEntries) {
        for (const [candidate, entry] of entries) {
          if (entry.expiresAt !== null && entry.expiresAt <= now) entries.delete(candidate);
        }
      }
      if (entries.size >= maxEntries) return { ok: false };
      entries.set(key, { taskId: request.taskId, expiresAt: null });
      return { ok: true };
    },
    complete: async (request) => {
      const entry = entries.get(partition(request));
      if (entry?.taskId === request.taskId) entry.expiresAt = input.clock.now().getTime() + ttlMs;
    },
    release: async (request) => {
      const key = partition(request);
      if (entries.get(key)?.taskId === request.taskId) entries.delete(key);
    },
  };
}
