import type { PermissionScope } from '@coderax/contracts';
import type { AgentAdapter, AgentReport } from '../agents/types.js';
import type { Clock, IdGenerator } from '../support/clock.js';
import type { ExecutionRepository } from '../persistence/executions.js';
import type { CapabilityBroker, CapabilityScope } from './capabilities.js';
import type {
  ExecutionCause,
  ExecutionIdentity,
  ExecutionRecord,
  ExecutionSummary,
} from './identity.js';
import { summarizeExecution } from './identity.js';
import type { ToolExecutionGuard } from './guard.js';
import type { RunOutcome } from './runner.js';
import type {
  IsolationCapability,
  TerminationEvidence,
  WorkloadIsolationProvider,
} from './termination.js';
import { toTerminationRecord } from './termination.js';

/**
 * The centralized execution supervisor.
 *
 * Every tool-capable operation — a Work run and a Chat turn alike — passes
 * through `run`. Nothing else calls an adapter, because the things that make an
 * execution safe are only possible if one component owns all of them:
 *
 * 1. A durable execution identity is written before the adapter starts, so the
 *    attempt exists even if this process dies mid-run.
 * 2. A scoped capability grant is issued for exactly this execution. Revoking it
 *    is synchronous, so a cancelled or superseded adapter cannot start another
 *    tool call even while it is still looping.
 * 3. Cancellation, interruption and shutdown are separate causes. Interruption
 *    never writes terminal state; shutdown leaves the task for startup
 *    reconciliation; cancellation is the owner's decision.
 * 4. Termination is recorded as `verified` only from evidence. A resolved
 *    adapter promise is not evidence. When no evidence exists the workspace root
 *    is held, so a new run cannot write alongside code this process can no longer
 *    observe.
 *
 * What this is not: a syscall sandbox. It bounds authority and reports honestly
 * what it cannot prove (see `isolation()` and `docs/supervisor.md`).
 */

export type SupervisorDeps = {
  clock: Clock;
  ids: IdGenerator;
  executions: ExecutionRepository;
  capabilities: CapabilityBroker;
  isolation: WorkloadIsolationProvider;
  /** How long a root stays held after an unverified termination. */
  containmentHoldMs: number;
  /** How long shutdown waits for running attempts to unwind. */
  shutdownGraceMs: number;
  /** Durable liveness interval for execution records. */
  heartbeatIntervalMs: number;
};

export type SupervisedExecution = {
  identity: ExecutionIdentity;
  workspaceRoot: string;
  signal: AbortSignal;
  guard: ToolExecutionGuard;
  /** Already gated: events are dropped once the execution loses authority. */
  report: AgentReport;
};

export type SupervisionLaunch = {
  outcome: RunOutcome;
  ownershipLost?: boolean;
  /** The adapter ignored its abort; it may still be executing. */
  abandoned?: boolean;
  /** Evidence supplied by a component that actually observed the workload. */
  termination?: TerminationEvidence;
};

export type SupervisionRefusal = {
  admitted: false;
  executionId: string;
  code: 'shutting_down' | 'workspace_busy' | 'workspace_denied' | 'execution_duplicate';
  detail: string;
};

export type SupervisionResult =
  | SupervisionRefusal
  | {
      admitted: true;
      executionId: string;
      outcome: RunOutcome;
      ownershipLost: boolean;
      abandoned: boolean;
      cause: ExecutionCause;
      termination: TerminationEvidence;
      workspaceHeld: boolean;
      record: ExecutionRecord;
    };

export type IsolationReport = {
  status: 'ok' | 'degraded';
  detail: string;
  capabilities: IsolationCapability[];
  activeExecutions: number;
  heldWorkspaces: number;
  provider: { name: string; available: boolean };
};

export type ShutdownReport = {
  aborted: number;
  verified: number;
  unverified: number;
};

export type ExecutionSupervisor = {
  run: (input: {
    identity: ExecutionIdentity;
    adapter: Pick<AgentAdapter, 'agent' | 'workload'>;
    workspaceRoot: string;
    scopes: readonly PermissionScope[];
    report?: AgentReport;
    launch: (execution: SupervisedExecution) => Promise<SupervisionLaunch>;
  }) => Promise<SupervisionResult>;
  /** Owner's decision: the run is aborted and reported as cancelled. */
  cancel: (executionId: string, reason?: string) => boolean;
  /** Engine authority lost: the run is aborted and never settles terminal state. */
  interrupt: (executionId: string, reason?: string) => boolean;
  shutdown: () => Promise<ShutdownReport>;
  isolation: () => IsolationReport;
  /** The reason a root is held after an unverified termination, if any. */
  held: (root: string) => string | null;
  active: () => Promise<ExecutionSummary[]>;
  history: (taskId: string) => Promise<ExecutionSummary[]>;
  retireStale: (staleAfterMs: number) => Promise<number>;
};

type ActiveExecution = {
  identity: ExecutionIdentity;
  controller: AbortController;
  requested: 'cancel' | 'interrupt' | 'shutdown' | null;
  done: Promise<void>;
};

const NON_FILESYSTEM_SCOPES: ReadonlySet<PermissionScope> = new Set([
  'command.execute',
  'network.access',
  'memory.read',
  'memory.write',
  'knowledge.read',
  'knowledge.write',
  'conversation.read',
  'credential.use',
  'browser.use',
]);

function capabilityScopes(
  scopes: readonly PermissionScope[],
  workspaceRoot: string,
): CapabilityScope[] {
  return scopes.map((scope) => ({
    scope,
    resource: NON_FILESYSTEM_SCOPES.has(scope) ? '*' : workspaceRoot,
  }));
}

/** A provider that throws is an unavailable provider, never a verified one. */
async function verifyWith(
  provider: WorkloadIsolationProvider,
  input: { executionId: string; workspaceRoot: string; observedAt: string },
): Promise<TerminationEvidence> {
  try {
    return await provider.verifyTermination(input);
  } catch {
    return {
      kind: 'unverified',
      reason: 'workload_isolation_unavailable',
      observedAt: input.observedAt,
      detail: 'The workload-isolation provider failed while verifying termination.',
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export function createExecutionSupervisor(deps: SupervisorDeps): ExecutionSupervisor {
  const active = new Map<string, ActiveExecution>();
  const activeRoots = new Map<string, string>();
  const heldRoots = new Map<
    string,
    { until: number; executionId: string; reason: string }
  >();
  let draining = false;

  function hold(
    root: string,
    executionId: string,
    reason: string,
    now: Date,
  ): void {
    heldRoots.set(root, {
      until: now.getTime() + deps.containmentHoldMs,
      executionId,
      reason,
    });
  }

  function refused(
    code: SupervisionRefusal['code'],
    detail: string,
    executionId: string,
  ): SupervisionRefusal {
    return { admitted: false, executionId, code, detail };
  }

  /**
   * Termination is a decision, not a passthrough. The adapter's own claim is
   * accepted only when it is at least as strong as what this process observed:
   * a run that exercised a process-spawning tool can never be `verified` merely
   * because the adapter returned.
   */
  async function decideTermination(input: {
    executionId: string;
    workspaceRoot: string;
    adapter: Pick<AgentAdapter, 'agent' | 'workload'>;
    abandoned: boolean;
    ownershipLost: boolean;
    spawned: boolean;
    supplied?: TerminationEvidence;
  }): Promise<TerminationEvidence> {
    const observedAt = deps.clock.iso();
    const workload =
      input.adapter.workload ?? (input.adapter.agent === 'coderax' ? 'in-process' : 'external');

    if (input.abandoned || input.ownershipLost) {
      return {
        kind: 'unverified',
        reason: 'adapter_abandoned',
        observedAt,
        detail: 'The engine stopped waiting for the adapter; it may still be executing.',
      };
    }

    if (input.supplied?.kind === 'verified' && !input.spawned) {
      return input.supplied;
    }

    if (workload === 'external' || input.spawned) {
      return verifyWith(deps.isolation, {
        executionId: input.executionId,
        workspaceRoot: input.workspaceRoot,
        observedAt,
      });
    }

    return {
      kind: 'verified',
      method: 'no-child-processes',
      observedAt,
      detail: 'The tool broker observed every call and none could spawn a process.',
    };
  }

  return {
    run: async (input) => {
      const now = deps.clock.now();
      const startedAt = now.toISOString();
      const root = input.workspaceRoot.trim();

      if (draining) {
        return refused(
          'shutting_down',
          'The engine is shutting down and is not admitting new executions.',
          input.identity.executionId,
        );
      }
      if (root.length === 0) {
        return refused(
          'workspace_denied',
          'An execution requires a resolved workspace root.',
          input.identity.executionId,
        );
      }

      // Only an execution that can change the workspace owns it. A read-only Chat
      // turn may run alongside an active Work run; two writers may not.
      const exclusive = input.scopes.some(
        (scope) => scope === 'workspace.write' || scope === 'command.execute',
      );
      const busy = exclusive ? activeRoots.get(root) : undefined;
      let replacing = false;
      if (busy) {
        const running = active.get(busy);
        // A newer generation of the same task is a supersession, not a conflict:
        // resume exists precisely to replace a run that lost authority. The old
        // attempt is interrupted and its capability is revoked before this one
        // starts, so it cannot continue external side effects.
        const supersedes =
          running !== undefined &&
          input.identity.kind === 'work' &&
          running.identity.kind === 'work' &&
          running.identity.taskId !== null &&
          running.identity.taskId === input.identity.taskId &&
          input.identity.generation > running.identity.generation;
        if (!supersedes) {
          return refused(
            'workspace_busy',
            'Another supervised execution currently holds this workspace root.',
            input.identity.executionId,
          );
        }
        replacing = true;
        if (running.requested !== 'shutdown') {
          running.requested = 'interrupt';
          running.controller.abort();
        }
      }
      const held = heldRoots.get(root);
      if (held) {
        if (held.until > now.getTime()) {
          return refused(
            'workspace_denied',
            'This workspace root is held because a previous execution could not be verified as terminated.',
            input.identity.executionId,
          );
        }
        heldRoots.delete(root);
      }

      /*
       * Admission and reservation are one synchronous step. The durable write
       * below is an await: two calls that both passed the check above would
       * otherwise launch with write authority over the same root. A superseding
       * generation may take the reservation over because the older execution's
       * cleanup only removes a reservation that still names it.
       */
      if (exclusive) {
        const reserved = activeRoots.get(root);
        if (reserved !== undefined && !(replacing && reserved === busy)) {
          return refused(
            'workspace_busy',
            'Another supervised execution currently holds this workspace root.',
            input.identity.executionId,
          );
        }
        activeRoots.set(root, input.identity.executionId);
      }
      const releaseReservation = (): void => {
        if (exclusive && activeRoots.get(root) === input.identity.executionId) {
          activeRoots.delete(root);
        }
      };

      const record: ExecutionRecord = {
        ...input.identity,
        workspaceRoot: root,
        phase: 'starting',
        cause: null,
        startedAt,
        lastHeartbeatAt: startedAt,
        finishedAt: null,
        termination: null,
        capabilityRevokedAt: null,
        processUseCount: 0,
      };
      let created: boolean;
      try {
        created = await deps.executions.create(record);
      } catch (error) {
        releaseReservation();
        throw error;
      }
      if (!created) {
        releaseReservation();
        return refused(
          'execution_duplicate',
          'That execution identity already exists.',
          input.identity.executionId,
        );
      }

      deps.capabilities.issue({
        grantId: deps.ids.requestId(),
        executionId: input.identity.executionId,
        scopes: capabilityScopes(input.scopes, root),
        now,
        // The grant is bounded by revocation, not by the clock. A long legitimate
        // run must not lose tool authority halfway through; a dead process loses
        // it with the process.
        ttlMs: 24 * 60 * 60_000,
      });

      const controller = new AbortController();
      let resolveDone: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const entry: ActiveExecution = {
        identity: input.identity,
        controller,
        requested: null,
        done,
      };
      active.set(input.identity.executionId, entry);
      void deps.executions
        .heartbeat(input.identity.executionId, startedAt)
        .catch(() => false);
      const heartbeat = setInterval(() => {
        void deps.executions
          .heartbeat(input.identity.executionId, deps.clock.iso())
          .catch(() => false);
      }, deps.heartbeatIntervalMs);
      heartbeat.unref();

      const guard: ToolExecutionGuard = {
        executionId: input.identity.executionId,
        live: () =>
          !controller.signal.aborted &&
          deps.capabilities.isLive(input.identity.executionId),
        permits: (scope, resource) =>
          !controller.signal.aborted &&
          deps.capabilities.authorize({
            executionId: input.identity.executionId,
            scope,
            resource,
            now: deps.clock.now(),
          }) === 'permitted',
        recordUse: ({ scope, resource, spawnsProcesses }) =>
          deps.capabilities.recordUse({
            executionId: input.identity.executionId,
            scope,
            resource,
            spawnsProcesses,
            now: deps.clock.now(),
          }),
      };

      const report: AgentReport = (event) => {
        if (!guard.live()) return;
        input.report?.(event);
      };

      let outcome: RunOutcome = {
        kind: 'failed',
        code: 'provider_error',
        detail: 'The execution failed unexpectedly.',
        retryable: false,
      };
      let ownershipLost = false;
      let abandoned = false;
      let supplied: TerminationEvidence | undefined;

      try {
        const launched = await input.launch({
          identity: input.identity,
          workspaceRoot: root,
          signal: controller.signal,
          guard,
          report,
        });
        outcome = launched.outcome;
        ownershipLost = launched.ownershipLost === true;
        abandoned = launched.abandoned === true;
        supplied = launched.termination;
      } catch {
        outcome = {
          kind: 'failed',
          code: 'provider_error',
          detail: 'The execution failed unexpectedly.',
          retryable: false,
        };
      } finally {
        clearInterval(heartbeat);
        // Revoke before anything else: from this point no tool call this
        // execution makes can start, whatever the adapter is still doing.
        deps.capabilities.revoke(input.identity.executionId, deps.clock.now());
      }

      const uses = deps.capabilities.uses(input.identity.executionId);
      const processUseCount = uses.filter((use) => use.spawnsProcesses).length;
      const termination = await decideTermination({
        executionId: input.identity.executionId,
        workspaceRoot: root,
        adapter: input.adapter,
        abandoned,
        ownershipLost,
        spawned: processUseCount > 0,
        ...(supplied ? { supplied } : {}),
      });

      const requested = entry.requested;
      const cause: ExecutionCause = ownershipLost
        ? 'interrupted'
        : requested === 'shutdown'
          ? 'shutdown'
          : requested === 'interrupt'
            ? 'interrupted'
            : outcome.kind === 'completed'
              ? 'completed'
              : outcome.kind === 'suspended'
                ? 'suspended'
                : outcome.kind === 'cancelled'
                  ? 'cancelled'
                  : outcome.kind === 'interrupted'
                    ? 'interrupted'
                    : 'failed';

      const finishedAt = deps.clock.iso();
      // A storage failure must not leave the attempt registered as live in this
      // process: release the slot and the hold regardless, and let startup
      // reconciliation retire the durable row.
      let finished: ExecutionRecord | null = null;
      try {
        finished = await deps.executions.finish({
          executionId: input.identity.executionId,
          cause,
          finishedAt,
          termination: toTerminationRecord(termination),
          capabilityRevokedAt: finishedAt,
          processUseCount,
        });
      } catch {
        finished = null;
      }

      active.delete(input.identity.executionId);
      releaseReservation();

      const workspaceHeld = termination.kind === 'unverified';
      if (workspaceHeld) {
        hold(root, input.identity.executionId, termination.reason, deps.clock.now());
      }
      resolveDone();

      return {
        admitted: true,
        executionId: input.identity.executionId,
        outcome,
        ownershipLost,
        abandoned,
        cause,
        termination,
        workspaceHeld,
        record:
          finished ??
          {
            ...record,
            phase: 'finished',
            cause,
            finishedAt,
            lastHeartbeatAt: finishedAt,
            termination: toTerminationRecord(termination),
            capabilityRevokedAt: finishedAt,
            processUseCount,
          },
      };
    },

    cancel: (executionId) => {
      const entry = active.get(executionId);
      if (!entry) return false;
      if (entry.requested !== 'shutdown') entry.requested = 'cancel';
      entry.controller.abort();
      return true;
    },

    interrupt: (executionId) => {
      const entry = active.get(executionId);
      if (!entry) return false;
      if (entry.requested !== 'shutdown') entry.requested = 'interrupt';
      entry.controller.abort();
      return true;
    },

    shutdown: async () => {
      draining = true;
      const entries = [...active.values()];
      for (const entry of entries) {
        entry.requested = 'shutdown';
        entry.controller.abort();
      }
      await Promise.race([
        Promise.all(entries.map((entry) => entry.done)),
        delay(deps.shutdownGraceMs),
      ]);

      let verified = 0;
      let unverified = 0;
      for (const entry of entries) {
        const record = await deps.executions.get(entry.identity.executionId);
        if (record?.termination?.status === 'verified') verified += 1;
        else unverified += 1;
      }
      return { aborted: entries.length, verified, unverified };
    },

    held: (root) => {
      const entry = heldRoots.get(root);
      if (!entry) return null;
      if (entry.until > deps.clock.now().getTime()) return entry.reason;
      heldRoots.delete(root);
      return null;
    },

    isolation: () => {
      const capabilities: IsolationCapability[] = [
        {
          name: 'filesystem',
          status: 'bounded',
          detail:
            'Tools are confined to the resolved workspace root by path, not by a syscall boundary; chmod or rename cannot revoke an already-open descriptor.',
        },
        {
          name: 'process',
          status: 'bounded',
          detail:
            'Cancellation aborts the run and bounds the wait; descendant processes are not verifiably terminated from this process.',
        },
        {
          name: 'credentials',
          status: 'enforced',
          detail:
            'Child processes receive an allow-listed environment; engine secrets are never exported to them.',
        },
        {
          name: 'network',
          status: 'bounded',
          detail:
            'Network tools are opt-in and host allow-listed; an external agent egresses from outside this process.',
        },
        {
          name: 'cross-replica-containment',
          status: 'unavailable',
          detail:
            'Capability revocation and workspace holds are process-local; no shared-store coordination is verified, so this is not cross-replica containment.',
        },
        {
          name: 'workload',
          status: deps.isolation.available ? 'enforced' : 'unavailable',
          detail: deps.isolation.available
            ? `${deps.isolation.name} verifies workload termination.`
            : `${deps.isolation.name} cannot verify workload termination, so such executions are recorded unverified.`,
        },
      ];
      const activeExecutions = active.size;
      const heldWorkspaces = heldRoots.size;
      const detail =
        `${activeExecutions} active execution(s); ${heldWorkspaces} held workspace(s); ` +
        `workload isolation ${deps.isolation.available ? 'available' : 'unavailable'}; containment is process-local.`;
      return {
        // Unavailable workload isolation is reported in the detail and in the
        // capability list, not as an engine failure: the engine is designed to
        // operate without it and becomes more conservative instead. A held root
        // is an active restriction, so that does degrade the report.
        status: heldWorkspaces > 0 ? 'degraded' : 'ok',
        detail: detail.slice(0, 500),
        capabilities,
        activeExecutions,
        heldWorkspaces,
        provider: { name: deps.isolation.name, available: deps.isolation.available },
      };
    },

    active: async () => (await deps.executions.listActive()).map(summarizeExecution),

    history: async (taskId) =>
      (await deps.executions.listByTask(taskId)).map(summarizeExecution),

    retireStale: async (staleAfterMs) => {
      const now = deps.clock.now();
      return deps.executions.retireStale({
        before: new Date(now.getTime() - staleAfterMs).toISOString(),
        at: now.toISOString(),
      });
    },
  };
}
