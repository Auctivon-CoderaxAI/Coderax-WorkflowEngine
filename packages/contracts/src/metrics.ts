import { z } from 'zod';
import { IsoDateTime } from './primitives.js';

const Count = z.number().int().nonnegative();

/**
 * One scrape of the engine's own counters.
 *
 * These are process-local operational counters, not billing records. Durable
 * facts (tasks, receipts, notifications) live in their stores and are read from
 * there; a restart resets the request and lease counters, which is why the
 * snapshot also carries `startedAt` and `uptimeMs`.
 */
export const MetricsReport = z
  .object({
    startedAt: IsoDateTime,
    uptimeMs: Count,
    requests: z
      .object({
        total: Count,
        active: Count,
        succeeded: Count,
        rejected: Count,
        failed: Count,
      })
      .strict(),
    queue: z
      .object({
        active: Count,
        pending: Count,
        maxConcurrent: z.number().int().positive(),
      })
      .strict(),
    tasks: z
      .object({
        total: Count,
        byState: z
          .object({
            queued: Count,
            running: Count,
            awaiting_approval: Count,
            completed: Count,
            failed: Count,
            cancelled: Count,
            interrupted: Count,
          })
          .strict(),
      })
      .strict(),
    events: z.object({ dropped: Count }).strict(),
    leases: z
      .object({
        renewFailed: Count,
        renewError: Count,
        fencingFailed: Count,
      })
      .strict(),
    audit: z.object({ receipts: Count }).strict(),
    persistence: z
      .object({
        driver: z.enum(['in_memory', 'mongo']),
        durable: z.boolean(),
        ok: z.boolean(),
        latencyMs: Count,
        checkedAt: IsoDateTime,
        detail: z.string().max(500),
      })
      .strict(),
  })
  .strict();
export type MetricsReport = z.infer<typeof MetricsReport>;
