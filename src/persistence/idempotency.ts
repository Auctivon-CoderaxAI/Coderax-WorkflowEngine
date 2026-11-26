import type { Clock } from '../support/clock.js';

type Reservation = { ownerId: string; key: string; taskId: string };
type ReserveResult = { ok: true } | { ok: false; completedTaskId?: string; pendingTaskId?: string };
export type IdempotencyStore = {
  reserve: (input: Reservation) => Promise<ReserveResult>;
  complete: (input: Reservation) => void;
  release: (input: Reservation) => Promise<void>;
};

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
    complete: (request) => {
      const entry = entries.get(partition(request));
      if (entry?.taskId === request.taskId) entry.expiresAt = input.clock.now().getTime() + ttlMs;
    },
    release: async (request) => {
      const key = partition(request);
      if (entries.get(key)?.taskId === request.taskId) entries.delete(key);
    },
  };
}
