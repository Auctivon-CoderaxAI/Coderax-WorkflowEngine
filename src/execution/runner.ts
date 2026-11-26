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
}): TaskRunner {
  return {
    run: async ({ scope, token, adapter, request, report }) => {
      const key = workRunKey(scope);
      const controller = new AbortController();
      let ownershipLost = false;
      let cancelRequested = false;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          timeout = setTimeout(() => reject(new Error('Cleanup deadline exceeded')), 5000);
        }, { once: true });
      });
      const onExternalAbort = (): void => {
        cancelRequested = true;
        controller.abort();
      };
      if (request.signal.aborted) onExternalAbort();
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

      try {
        const outcome = await Promise.race([
          adapter.run({ ...request, signal: controller.signal }, event => {
            if (!controller.signal.aborted) report(event);
          }),
          deadline,
        ]);
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
        if (cancelRequested) return { outcome: { kind: 'cancelled' }, ownershipLost: false };
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
        clearTimeout(timeout);
        request.signal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}
