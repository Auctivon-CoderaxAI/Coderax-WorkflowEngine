import type { RetentionConfig } from '../configuration/schema.js';
import type { Clock } from '../support/clock.js';
import type { AuditLog } from '../observability/audit.js';
import type { NotificationStore } from './notifications.js';
import type { PermissionStore } from '../permissions/store.js';
import type { CheckpointStore } from './checkpoints.js';
import type { IdempotencyStore } from './idempotency.js';

/**
 * Bounded lifecycle maintenance.
 *
 * Every store has its own window and each sweep removes at most `batchSize` rows
 * per pass, so retention never turns into an unbounded delete in a request. The
 * sweep is safe to run on every replica: the deletes are conditional on the age
 * of the row, so a concurrent replica removing the same row is harmless.
 */
export type RetentionCounts = {
  notifications: number;
  audit: number;
  permissions: number;
  checkpoints: number;
  idempotency: number;
};

export type RetentionResult = {
  ranAt: string;
  durationMs: number;
  deleted: RetentionCounts;
};

export type RetentionService = {
  run: (now?: Date) => Promise<RetentionResult>;
  last: () => RetentionResult | null;
  /** Starts the periodic sweep; the timer is unref'd so it cannot hold a process. */
  start: () => void;
  stop: () => void;
};

const MAX_BATCHES = 10;

export function createRetentionService(input: {
  clock: Clock;
  config: RetentionConfig;
  notifications: NotificationStore;
  audit: AuditLog;
  permissions: PermissionStore;
  checkpoints: CheckpointStore;
  idempotency: IdempotencyStore;
}): RetentionService {
  let last: RetentionResult | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function drain(
    prune: (before: string, limit: number) => Promise<number>,
    before: string,
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await prune(before, input.config.batchSize);
      total += removed;
      if (removed < input.config.batchSize) break;
    }
    return total;
  }

  async function run(now?: Date): Promise<RetentionResult> {
    const started = Date.now();
    const at = now ?? input.clock.now();
    const before = (ms: number): string => new Date(at.getTime() - ms).toISOString();
    const deleted: RetentionCounts = {
      notifications: await drain(
        (cutoff, limit) => input.notifications.prune(cutoff, limit),
        before(input.config.notificationMs),
      ),
      audit: await drain(
        (cutoff, limit) => input.audit.prune(cutoff, limit),
        before(input.config.auditMs),
      ),
      permissions: await drain(
        (cutoff, limit) => input.permissions.prune(cutoff, limit),
        before(input.config.permissionMs),
      ),
      checkpoints: await drain(
        (cutoff, limit) => input.checkpoints.prune(cutoff, limit),
        before(input.config.checkpointMs),
      ),
      idempotency: await drain(
        (cutoff, limit) => input.idempotency.prune(cutoff, limit),
        before(input.config.idempotencyMs),
      ),
    };
    last = {
      ranAt: at.toISOString(),
      durationMs: Date.now() - started,
      deleted,
    };
    return last;
  }

  return {
    run,
    last: () => last,
    start: () => {
      if (timer) return;
      timer = setInterval(() => {
        void run().catch(() => undefined);
      }, input.config.sweepIntervalMs);
      timer.unref();
    },
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
