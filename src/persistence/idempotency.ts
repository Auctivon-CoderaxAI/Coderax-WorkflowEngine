import type { Clock } from '../support/clock.js';

/**
 * An idempotency key maps one caller intent to one task.
 *
 * The key is reserved before the task is claimed, so two concurrent submissions
 * of the same intent cannot both create a run: the loser reads the winner's task
 * id and answers with it. A reservation whose task was never created is released
 * so a genuine retry can proceed. Entries expire, so a retried request from an
 * hour ago does not resurrect a task the owner already abandoned.
 */
export type IdempotencyStore = {
  lookup: (ownerId: string, key: string) => Promise<string | null>;
  reserve: (input: {
    ownerId: string;
    key: string;
    taskId: string;
  }) => Promise<{ ok: true } | { ok: false; taskId: string }>;
  release: (ownerId: string, key: string) => Promise<void>;
};

export function createIdempotencyStore(input: {
  clock: Clock;
  ttlMs?: number;
  maxEntries?: number;
}): IdempotencyStore {
  const ttlMs = input.ttlMs ?? 86_400_000;
  const maxEntries = input.maxEntries ?? 10_000;
  const entries = new Map<string, { taskId: string; expiresAt: number }>();

  function partition(ownerId: string, key: string): string {
    return JSON.stringify([ownerId, key]);
  }

  function live(partitionKey: string): { taskId: string; expiresAt: number } | null {
    const entry = entries.get(partitionKey);
    if (!entry) return null;
    if (entry.expiresAt <= input.clock.now().getTime()) {
      entries.delete(partitionKey);
      return null;
    }
    return entry;
  }

  function prune(): void {
    if (entries.size < maxEntries) return;
    const now = input.clock.now().getTime();
    for (const [partitionKey, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(partitionKey);
    }
    // Still full: drop the oldest insertions. Map iteration is insertion order.
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    lookup: async (ownerId, key) => live(partition(ownerId, key))?.taskId ?? null,
    reserve: async ({ ownerId, key, taskId }) => {
      const partitionKey = partition(ownerId, key);
      const existing = live(partitionKey);
      if (existing) return { ok: false, taskId: existing.taskId };
      prune();
      entries.set(partitionKey, {
        taskId,
        expiresAt: input.clock.now().getTime() + ttlMs,
      });
      return { ok: true };
    },
    release: async (ownerId, key) => {
      entries.delete(partition(ownerId, key));
    },
  };
}
