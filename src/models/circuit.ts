import type { CircuitState } from './types.js';

/**
 * A circuit per model and per provider. Three consecutive failures open it; one
 * probe is admitted after the cooldown. A half-open probe that fails reopens the
 * circuit instead of letting every request through.
 *
 * An admission token scopes cleanup and outcomes to the attempt that obtained
 * them. A request admitted while the circuit was closed cannot close, reopen or
 * release a probe that a later admission owns.
 */
export type CircuitAdmission = {
  /** True only for the single half-open probe. */
  readonly probe: boolean;
  readonly epoch: number;
};

export type Circuit = {
  allow: (now: Date) => CircuitAdmission | null;
  success: (admission?: CircuitAdmission) => void;
  failure: (now: Date, admission?: CircuitAdmission) => void;
  /** Release a half-open probe that never produced an outcome. */
  abandon: (admission?: CircuitAdmission) => void;
  state: (now: Date) => CircuitState;
  retryAfterMs: (now: Date) => number;
};

export function createCircuit(input: {
  failureThreshold: number;
  cooldownMs: number;
}): Circuit {
  let failures = 0;
  let openedAt: number | null = null;
  let probeEpoch: number | null = null;
  let epoch = 0;

  function state(now: Date): CircuitState {
    if (openedAt === null) return 'closed';
    if (now.getTime() - openedAt >= input.cooldownMs) return 'half_open';
    return 'open';
  }

  function ownsProbe(admission?: CircuitAdmission): boolean {
    return (
      admission?.probe === true &&
      probeEpoch !== null &&
      admission.epoch === probeEpoch
    );
  }

  return {
    allow: (now) => {
      const current = state(now);
      if (current === 'closed') return { probe: false, epoch: ++epoch };
      if (current === 'open') return null;
      if (probeEpoch !== null) return null;
      const admitted = ++epoch;
      probeEpoch = admitted;
      return { probe: true, epoch: admitted };
    },
    success: (admission) => {
      if (openedAt === null) {
        failures = 0;
        return;
      }
      // Only the current half-open probe can recover an open circuit.
      if (!ownsProbe(admission) && admission !== undefined) return;
      failures = 0;
      openedAt = null;
      probeEpoch = null;
    },
    failure: (now, admission) => {
      // A closed-state attempt that returns after the circuit opened is stale;
      // its failure must not reopen or extend the newer circuit. A probe from an
      // older cooldown is stale for the same reason.
      if (admission?.probe === false && openedAt !== null) return;
      if (admission?.probe === true && !ownsProbe(admission)) return;
      if (ownsProbe(admission) || admission === undefined) probeEpoch = null;
      failures += 1;
      if (failures >= input.failureThreshold) {
        openedAt = now.getTime();
      }
    },
    abandon: (admission) => {
      // A closed-state admission must never release someone else's probe.
      if (admission !== undefined && !ownsProbe(admission)) return;
      probeEpoch = null;
    },
    state,
    retryAfterMs: (now) => {
      if (openedAt === null) return 0;
      return Math.max(0, openedAt + input.cooldownMs - now.getTime());
    },
  };
}
