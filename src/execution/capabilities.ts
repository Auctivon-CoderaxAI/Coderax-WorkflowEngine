import path from 'node:path';
import type { PermissionScope } from '@coderax/contracts';

/**
 * Scoped authority for one execution.
 *
 * The engine holds the only credentials it has; it does not hand them to an
 * agent. What an agent receives is a grant naming the scopes and the resource it
 * may touch, and that grant dies with the execution. Revoking is therefore
 * synchronous and total: after `revoke(executionId)` every authorization for
 * that execution is refused, including one racing a tool call.
 *
 * This is not a credential store and does not contain a secret. A credential a
 * child process needs is supplied through an explicit environment allow-list
 * (`src/security/environment.ts`), never by exporting the engine's own.
 */

export type CapabilityScope = {
  scope: PermissionScope;
  /** An absolute root, or `*` for non-filesystem scopes. */
  resource: string;
};

export type CapabilityGrant = {
  grantId: string;
  executionId: string;
  scopes: CapabilityScope[];
  issuedAt: string;
  expiresAt: string;
};

export type CapabilityUse = {
  scope: PermissionScope;
  resource: string;
  spawnsProcesses: boolean;
  at: string;
};

export type CapabilityDecision = 'permitted' | 'not-granted' | 'revoked' | 'expired';

export type CapabilityBroker = {
  issue: (input: {
    grantId: string;
    executionId: string;
    scopes: CapabilityScope[];
    now: Date;
    ttlMs: number;
  }) => CapabilityGrant;
  authorize: (input: {
    executionId: string;
    scope: PermissionScope;
    resource: string;
    now: Date;
  }) => CapabilityDecision;
  recordUse: (input: {
    executionId: string;
    scope: PermissionScope;
    resource: string;
    spawnsProcesses: boolean;
    now: Date;
  }) => void;
  revoke: (executionId: string, now: Date) => boolean;
  isLive: (executionId: string) => boolean;
  uses: (executionId: string) => CapabilityUse[];
  grants: (executionId: string) => CapabilityGrant[];
  active: () => string[];
};

/**
 * Resource matching is resolved, not textual.
 *
 * A workspace tool names its resource the way the owner sees it (`report.txt`),
 * while the grant names the resolved root. Both forms are therefore resolved
 * against the granted root, and a `..` that escapes it is refused. Non-path
 * scopes use an explicit `*`; the owner's approval still names the exact
 * resource, so the wildcard cannot widen an approval.
 */
function covers(granted: string, requested: string, scope: PermissionScope): boolean {
  if (granted === '*') return true;
  if (granted === requested) return true;
  if (scope === 'workspace.read' || scope === 'workspace.write') {
    const root = path.resolve(granted);
    const resolved = path.resolve(root, requested);
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
  const root = granted.endsWith('/') ? granted.slice(0, -1) : granted;
  if (root.length === 0) return false;
  return requested.startsWith(`${root}/`);
}

export function createCapabilityBroker(): CapabilityBroker {
  type Entry = {
    grant: CapabilityGrant;
    uses: CapabilityUse[];
  };
  const entries = new Map<string, Entry[]>();
  const revoked = new Set<string>();

  function entriesFor(executionId: string): Entry[] {
    return entries.get(executionId) ?? [];
  }

  return {
    issue: ({ grantId, executionId, scopes, now, ttlMs }) => {
      revoked.delete(executionId);
      const grant: CapabilityGrant = {
        grantId,
        executionId,
        scopes: scopes.map((entry) => ({ ...entry })),
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      const list = entriesFor(executionId);
      list.push({ grant, uses: [] });
      entries.set(executionId, list);
      return grant;
    },

    authorize: ({ executionId, scope, resource, now }) => {
      if (revoked.has(executionId)) return 'revoked';
      const grants = entriesFor(executionId);
      if (grants.length === 0) return 'revoked';
      let expired = false;
      for (const entry of grants) {
        if (new Date(entry.grant.expiresAt).getTime() <= now.getTime()) {
          expired = true;
          continue;
        }
        const match = entry.grant.scopes.find(
          (candidate) =>
            candidate.scope === scope && covers(candidate.resource, resource, scope),
        );
        if (match) return 'permitted';
      }
      return expired ? 'expired' : 'not-granted';
    },

    recordUse: ({ executionId, scope, resource, spawnsProcesses, now }) => {
      for (const entry of entriesFor(executionId)) {
        entry.uses.push({ scope, resource, spawnsProcesses, at: now.toISOString() });
      }
    },

    revoke: (executionId, now) => {
      const existed = entries.has(executionId);
      revoked.add(executionId);
      const entriesForExecution = entries.get(executionId);
      if (entriesForExecution) {
        // Keep the grant and its use log for the durable record, but make every
        // entry unable to authorize anything by expiring it at the revoke time.
        for (const entry of entriesForExecution) {
          entry.grant = { ...entry.grant, expiresAt: now.toISOString() };
        }
      }
      return existed;
    },

    isLive: (executionId) => entries.has(executionId) && !revoked.has(executionId),

    uses: (executionId) =>
      entriesFor(executionId).flatMap((entry) => entry.uses.map((use) => ({ ...use }))),

    grants: (executionId) =>
      entriesFor(executionId).map((entry) => ({
        ...entry.grant,
        scopes: entry.grant.scopes.map((scope) => ({ ...scope })),
      })),

    active: () => [...entries.keys()].filter((executionId) => !revoked.has(executionId)),
  };
}
