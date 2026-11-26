import type { EngineFailureCode, Usage } from '@coderax/contracts';
import type { Clock } from '../support/clock.js';
import type { LeaseStore, RunScope } from './lease.js';
import { workRunKey } from './lease.js';
import type { AgentAdapter, AgentReport, AgentRunRequest } from '../agents/types.js';

export type RunOutcome =
  | { kind: 'completed'; summary: string; usage?: Usage }
  | { kind: 'failed'; code: EngineFailureCode; detail: string; retryable: boolean }
  /** `abandoned` means the adapter ignored its abort and may still be running. */
  | { kind: 'cancelled'; abandoned?: boolean }
  | { kind: 'interrupted'; detail: string }
  /** The run needs an owner decision; its checkpoint is durable and resumable. */
  | { kind: 'suspended'; detail: string };

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
    /** The fencing generation this run belongs to (used when it is abandoned). */
    generation?: number;
    /** The directory the run may write, quarantined if the adapter is abandoned. */
    workspaceRoot?: string;
  }) => Promise<RunResult>;
};

/**
 * Executes one agent run while holding its lease.
 *
 * The heartbeat is the only thing that proves this process still owns the task. A
 * failed renewal aborts the run and reports `interrupted`; a durable cancel flag
 * observed on renewal aborts it as cancelled. Either way the run settles exactly
 * once, so a caller never has to guess whether a run is still live.
 *
 * Cancellation is bounded but not magical. The grace clock starts when the run is
 * aborted; if the adapter ignores that abort, the engine stops waiting and
 * reports `cancelled` with `abandoned: true`. It also seals the adapter's report
 * channel, so a late event from the abandoned run cannot reach the bus. What it
 * cannot do in-process is kill code that is still executing — the caller
 * quarantines the workspace for that, which is the fail-closed part.
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
  /** Called when a run is abandoned so the caller can quarantine its workspace. */
  onAbandoned?: (info: {
    scope: RunScope;
    token: string;
    generation: number;
    workspaceRoot: string;
  }) => void;
}): TaskRunner {
  return {
    run: async ({
      scope,
      token,
      adapter,
      request,
      report,
      generation = 0,
      workspaceRoot = '',
    }) => {
      const key = workRunKey(scope);
      const controller = new AbortController();
      let ownershipLost = false;
      let cancelRequested = false;

      const onExternalAbort = (): void => {
        cancelRequested = true;
        controller.abort();
      };
      // A signal that is already aborted never fires again; without this check a
      // cancellation that raced the start would be ignored entirely.
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

      // The adapter keeps the raw callback; the runner decides whether an event
      // may still be delivered. This is the second gate after the service's
      // controller check, and it is the one that survives a service bug.
      const guardedReport: AgentReport = (event) => {
        if (controller.signal.aborted) return;
        report(event);
      };

      const cancelled = (abandoned: boolean): RunResult =>
        ownershipLost
          ? {
              outcome: {
                kind: 'interrupted',
                detail: 'Execution ownership was superseded by another run.',
              },
              ownershipLost: true,
            }
          : { outcome: { kind: 'cancelled', ...(abandoned ? { abandoned: true } : {}) }, ownershipLost: false };

      try {
        const running = adapter.run({ ...request, signal: controller.signal }, guardedReport);
        const settled = await Promise.race([running.then((outcome) => ({ outcome })), grace]);
        if (settled === null) {
          // The adapter ignored the abort. Its eventual rejection must not become
          // an unhandled one, and its result must never be applied: the lease and
          // the task record already say this run is over.
          void running.catch(() => undefined);
          if (!ownershipLost) {
            input.onAbandoned?.({ scope, token, generation, workspaceRoot });
          }
          return cancelled(true);
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
        if (outcome.code === 'approval_required') {
          return {
            outcome: { kind: 'suspended', detail: outcome.detail },
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
        // An adapter that throws on abort was cancelled, not broken. Reporting a
        // provider failure here would tell the owner to retry something they
        // deliberately stopped.
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
        if (graceTimer) clearTimeout(graceTimer);
        request.signal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}
