/**
 * Workspace quarantine.
 *
 * A cancellation grace period bounds how long the engine *waits*, but it cannot
 * stop code that is already running inside the process: an adapter that ignores
 * its abort signal keeps executing until it returns. What the engine can do is
 * remove its authority and refuse to let it share state with anything else.
 *
 * Three things already remove its authority once the run is settled: the lease
 * is released under its own token, every task write is fenced to that token, and
 * the service drops reports whose controller is no longer current. The remaining
 * shared resource is the workspace directory, which an abandoned adapter may
 * still be writing to.
 *
 * This registry closes that gap by poisoning the root for a bounded window. A
 * new run in the same root is refused — `workspace_denied`, which is the same
 * fail-closed answer a bad root already gets — instead of running concurrently
 * with code the engine can no longer supervise. The entry expires so a
 * deployment recovers without an operator, and health reports the count.
 */
export type QuarantineEntry = {
  root: string;
  generation: number;
  taskId: string;
  reason: string;
  until: number;
};

export type QuarantineRegistry = {
  /** Records that `root` may still be written by an abandoned generation. */
  poison: (input: {
    root: string;
    generation: number;
    taskId: string;
    reason: string;
    now: number;
  }) => QuarantineEntry;
  /** The active entry for a root, or null when it is safe to use. */
  check: (root: string, now: number) => QuarantineEntry | null;
  /** Removes an entry early; used by tests and by an operator-facing reset. */
  release: (root: string) => boolean;
  list: (now: number) => QuarantineEntry[];
};

export function createQuarantineRegistry(input: { ttlMs: number }): QuarantineRegistry {
  const entries = new Map<string, QuarantineEntry>();

  return {
    poison: ({ root, generation, taskId, reason, now }) => {
      const entry: QuarantineEntry = {
        root,
        generation,
        taskId,
        reason,
        until: now + input.ttlMs,
      };
      entries.set(root, entry);
      return entry;
    },

    check: (root, now) => {
      const entry = entries.get(root);
      if (!entry) return null;
      if (entry.until <= now) {
        entries.delete(root);
        return null;
      }
      return entry;
    },

    release: (root) => entries.delete(root),

    list: (now) => {
      for (const [root, entry] of entries) {
        if (entry.until <= now) entries.delete(root);
      }
      return [...entries.values()];
    },
  };
}
