/**
 * A Work run lease outlives the process that started it.
 *
 * The lease is the only authority to execute a conversation's Work task. A run
 * heartbeats to renew it; a restart, crash or a cancellation handled by another
 * replica is therefore visible to everyone. The TTL bounds how long a dead run
 * may still claim to be running, and the same window is how long another
 * replica stays fenced out.
 */

export type RunScope = {
  ownerId: string;
  tenantId: string | null;
  conversationId: string;
};

export type LeaseClaim = {
  key: string;
  owner: string;
  /** Unique per claim. This is the fencing generation, never a counter reset. */
  token: string;
  now: Date;
  expiresAt: Date;
};

export type LeaseSnapshot = {
  token: string;
  /** Present for the in-process store; a database row may not expose it. */
  owner?: string;
  cancelRequested: boolean;
  expiresAt: Date;
  /** False once the holder stopped heartbeating: the run cannot still be live. */
  live: boolean;
};

export type CancelOutcome =
  /** A live lease was flagged; its owner aborts on the next heartbeat. */
  | 'requested'
  /** The lease had already expired, so the interrupted run was retired. */
  | 'interrupted'
  /** No run is known for this task. */
  | 'none';

export type LeaseStore = {
  claim: (input: LeaseClaim) => Promise<boolean>;
  renew: (input: {
    key: string;
    token: string;
    now: Date;
    expiresAt: Date;
  }) => Promise<{ renewed: boolean; cancelRequested: boolean }>;
  release: (input: { key: string; token: string }) => Promise<boolean>;
  cancel: (input: { key: string; now: Date }) => Promise<CancelOutcome>;
  read: (input: { key: string; now: Date }) => Promise<LeaseSnapshot | null>;
  prune: (input: { before: Date; limit: number }) => Promise<number>;
};

/** Tenant, owner and conversation together identify one Work task slot. */
export function workRunKey(scope: RunScope): string {
  return JSON.stringify([scope.tenantId ?? '', scope.ownerId, scope.conversationId]);
}

/**
 * A lease holder's fencing check. Terminal persistence must call this before it
 * writes: an expired or superseded generation is refused rather than allowed to
 * overwrite the state a newer generation owns.
 */
export function isAuthorizedGeneration(
  recordToken: string | null,
  holderToken: string,
): boolean {
  return recordToken !== null && recordToken.length > 0 && recordToken === holderToken;
}
