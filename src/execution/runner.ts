import type { EngineFailureCode, Usage } from '@coderax/contracts';
import type { Clock } from '../support/clock.js';
import type { LeaseStore, RunScope } from './lease.js';
import { workRunKey } from './lease.js';
import type { AgentAdapter, AgentReport, AgentRunRequest } from '../agents/types.js';

export type RunOutcome =
  | { kind: 'completed'; summary: string; usage?: Usage }
  | { kind: 'failed'; code: EngineFailureCode; detail: string; retryable: boolean }
  | { kind: 'cancelled' }
  | { kind: 'interrupted'; detail: string };

export type RunResult = {
  outcome: RunOutcome;
  /**
   * True when the lease could not be renewed. The caller must not write terminal
   * state in that case: another generation may already own the task.
   */
  ownershipLost: boolean;
};

export type TaskRunner = {
  run: (input: {
    scope: RunScope;
    token: string;
    adapter: AgentAdapter;
    request: AgentRunRequest;
    report: AgentReport;
  }) => Promise<RunResult>;
};

/**
 * Executes one agent run while holding its lease.
 *
 * The heartbeat is the only thing that proves this process still owns the task. A
 * failed renewal aborts the run and reports `interrupted`; a durable cancel flag
 * observed on renewal aborts it as cancelled. Either way the run settles exactly
 * once, so a caller never has to guess whether a run is still live.
 */
export function createTaskRunner(input: {
  lease: LeaseStore;
  clock: Clock;
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  /**
   * How long a cancelled adapter may take to stop before the engine stops
   * waiting. Without a bound, a provider that ignores its abort signal holds the
   * conversation's only run slot forever.
   */
  cleanupGraceMs: number;
}): TaskRunner {
  return {
    run: async ({ scope, token, adapter, request, report }) => {
      const key = workRunKey(scope);
      const controller = new AbortController();
      let ownershipLost = false;
      let cancelRequested = false;

      const onExternalAbort = (): void => controller.abort();
      request.signal.addEventListener('abort', onExternalAbort, { once: true });

      const heartbeat = async (): Promise<void> => {
        const now = input.clock.now();
        const result = await input.lease.renew({
          key,
          token,
          now,
          expiresAt: new Date(now.getTime() + input.leaseTtlMs),
        });
        if (!result.renewed) {
          ownershipLost = true;
          controller.abort();
          return;
        }
        if (result.cancelRequested) {
          cancelRequested = true;
          controller.abort();
        }
      };

      const timer = setInterval(() => {
        void heartbeat().catch(() => {
          ownershipLost = true;
          controller.abort();
        });
      }, input.heartbeatIntervalMs);
      timer.unref();

      // The grace clock starts when the run is aborted, not when it starts, so a
      // long legitimate run is never cut short.
      let graceTimer: NodeJS.Timeout | null = null;
      const grace = new Promise<null>((resolve) => {
        const start = (): void => {
          if (graceTimer) return;
          graceTimer = setTimeout(() => resolve(null), input.cleanupGraceMs);
          graceTimer.unref();
        };
        if (controller.signal.aborted) start();
        else controller.signal.addEventListener('abort', start, { once: true });
      });

      try {
        const running = adapter.run({ ...request, signal: controller.signal }, report);
        const settled = await Promise.race([running.then((outcome) => ({ outcome })), grace]);
        if (settled === null) {
          // The adapter ignored the abort. Its eventual rejection must not become
          // an unhandled one, and its result must never be applied: the lease and
          // the task record already say this run is over.
          void running.catch(() => undefined);
          return ownershipLost
            ? {
                outcome: {
                  kind: 'interrupted',
                  detail: 'Execution ownership was superseded by another run.',
                },
                ownershipLost: true,
              }
            : { outcome: { kind: 'cancelled' }, ownershipLost: false };
        }
        const outcome = settled.outcome;
        if (ownershipLost) {
          return {
            outcome: {
              kind: 'interrupted',
              detail: 'Execution ownership was superseded by another run.',
            },
            ownershipLost: true,
          };
        }
        if (cancelRequested || (!outcome.ok && outcome.code === 'cancelled')) {
          return { outcome: { kind: 'cancelled' }, ownershipLost: false };
        }
        if (outcome.ok) {
          return {
            outcome: {
              kind: 'completed',
              summary: outcome.summary,
              ...(outcome.usage ? { usage: outcome.usage } : {}),
            },
            ownershipLost: false,
          };
        }
        return {
          outcome: {
            kind: 'failed',
            code: outcome.code,
            detail: outcome.detail,
            retryable: outcome.retryable,
          },
          ownershipLost: false,
        };
      } catch {
        if (ownershipLost) {
          return {
            outcome: {
              kind: 'interrupted',
              detail: 'Execution ownership was superseded by another run.',
            },
            ownershipLost: true,
          };
        }
        return {
          outcome: {
            kind: 'failed',
            code: 'provider_error',
            detail: 'The agent failed unexpectedly.',
            retryable: false,
          },
          ownershipLost: false,
        };
      } finally {
        clearInterval(timer);
        if (graceTimer) clearTimeout(graceTimer);
        request.signal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}
