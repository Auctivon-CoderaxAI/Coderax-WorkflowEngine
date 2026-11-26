/**
 * What actually proves that an execution stopped.
 *
 * A resolved promise proves that an async function returned. It does not prove
 * that a child process exited, that a remote workload was destroyed, or that a
 * provider stopped billing. Those are different claims and the engine reports
 * them separately, because a supervisor that equates "the adapter returned" with
 * "nothing is still running" is making a promise it cannot keep.
 *
 * Evidence is therefore explicit and narrow:
 *
 * - `no-child-processes` means the execution's tool broker observed every tool
 *   call and none of them could spawn a process. This is verifiable in-process.
 * - `process-group-exited` and `workload-destroyed` can only be asserted by a
 *   component that owns the workload (a sandbox, a container runtime or a
 *   deployment platform). The engine never invents them.
 *
 * Everything else is `unverified`, which is a first-class outcome rather than an
 * error: the supervisor keeps the workspace root held so a new run cannot write
 * alongside code it can no longer observe.
 */

export type TerminationMethod =
  | 'no-child-processes'
  | 'process-group-exited'
  | 'workload-destroyed';

export type TerminationReason =
  /** The adapter resolved without evidence and did not start a workload. */
  | 'adapter_did_not_report'
  /** The adapter ignored its abort; it may still be executing. */
  | 'adapter_abandoned'
  /** A process was started and descendants cannot be observed from here. */
  | 'descendants_unobservable'
  /** No workload-isolation provider is configured, so nothing can verify it. */
  | 'workload_isolation_unavailable';

export type TerminationEvidence =
  | {
      kind: 'verified';
      method: TerminationMethod;
      observedAt: string;
      detail?: string;
    }
  | {
      kind: 'unverified';
      reason: TerminationReason;
      observedAt: string;
      detail?: string;
    };

/** The durable, serialisable form stored on an execution record. */
export type TerminationRecord = {
  status: 'verified' | 'unverified';
  method?: TerminationMethod;
  reason?: TerminationReason;
  observedAt: string;
  detail?: string;
};

export function toTerminationRecord(evidence: TerminationEvidence): TerminationRecord {
  return evidence.kind === 'verified'
    ? {
        status: 'verified',
        method: evidence.method,
        observedAt: evidence.observedAt,
        ...(evidence.detail ? { detail: evidence.detail } : {}),
      }
    : {
        status: 'unverified',
        reason: evidence.reason,
        observedAt: evidence.observedAt,
        ...(evidence.detail ? { detail: evidence.detail } : {}),
      };
}

export type IsolationStatus = 'enforced' | 'bounded' | 'unavailable';

export type IsolationCapability = {
  name:
    | 'filesystem'
    | 'process'
    | 'credentials'
    | 'network'
    | 'quarantine'
    | 'cross-replica-containment'
    | 'workload';
  status: IsolationStatus;
  /** Owner-readable, and deliberately no stronger than what is verified. */
  detail: string;
};

/**
 * The seam a deployment platform implements when it can actually own a workload.
 *
 * `verifyTermination` must observe the workload, not the adapter promise. A
 * provider that cannot do that reports `available: false`; the supervisor then
 * records `unverified` and holds the workspace instead of claiming containment.
 * That is the fail-closed integration contract: an unavailable platform makes the
 * engine more conservative, never more permissive.
 */
export type WorkloadIsolationProvider = {
  name: string;
  available: boolean;
  capabilities: IsolationCapability[];
  verifyTermination: (input: {
    executionId: string;
    workspaceRoot: string;
    observedAt: string;
  }) => Promise<TerminationEvidence>;
};

/**
 * The default provider: there is no platform integration in this deployment, so
 * no workload can be verified. It never reports success.
 */
export function createUnavailableIsolationProvider(detail: string): WorkloadIsolationProvider {
  return {
    name: 'deployment-platform',
    available: false,
    capabilities: [
      { name: 'filesystem', status: 'unavailable', detail },
      { name: 'process', status: 'unavailable', detail },
      { name: 'workload', status: 'unavailable', detail },
    ],
    verifyTermination: async ({ observedAt }) => ({
      kind: 'unverified',
      reason: 'workload_isolation_unavailable',
      observedAt,
      detail,
    }),
  };
}
