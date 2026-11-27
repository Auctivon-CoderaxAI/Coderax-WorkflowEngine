import type { Clock } from '../support/clock.js';
import { quarantineRunWorkspace } from './workspace.js';

/**
 * Execution supervision.
 *
 * A lease protects the task record; it does not protect the resources the run
 * was handed. A cancelled adapter that ignores its abort keeps its process-local
 * references and can keep using them until it actually returns. This registry is
 * the authority for "is this generation still allowed to act": every capability
 * is registered before the adapter starts, and removing it is the signal that
 * reports, tool calls and workspace writes from that generation must stop.
 *
 * The workspace is the resource that outlives the object graph, so revocation
 * renames the run's directory instead of flagging it. Code holding the old path
 * then sees a path that no longer exists.
 */

export type RunCapability = {
  taskId: string;
  token: string;
  generation: number;
  workspaceRoot: string;
  revoked: boolean;
};

export type RunSupervisor = {
  /** Registers the generation that is about to run; revokes any older token. */
  begin: (input: {
    taskId: string;
    token: string;
    generation: number;
    workspaceRoot: string;
  }) => Promise<RunCapability>;
  /** True only while this exact task/token pair is registered and not revoked. */
  isLive: (taskId: string, token: string) => boolean;
  /** The capability for a token, or null when it was never registered/revoked. */
  get: (token: string) => RunCapability | null;
  /** The adapter returned inside the grace bound; verified termination. */
  finish: (taskId: string, token: string) => void;
  /**
   * The adapter did not verify termination. Revokes the capability and
   * quarantines its workspace. Idempotent.
   */
  abandon: (input: { taskId?: string; token: string; reason?: string }) => Promise<boolean>;
  /** Registered, unrevoked capabilities. */
  live: () => RunCapability[];
  /** Shutdown: revoke and quarantine everything still registered. */
  shutdown: () => Promise<{ revoked: number; quarantined: number }>;
};

export function createRunSupervisor(input: { clock: Clock }): RunSupervisor {
  const byToken = new Map<string, RunCapability>();
  const tokenByTask = new Map<string, string>();

  function revoke(capability: RunCapability): void {
    if (capability.revoked) return;
    capability.revoked = true;
    byToken.delete(capability.token);
    const current = tokenByTask.get(capability.taskId);
    if (current === capability.token) tokenByTask.delete(capability.taskId);
  }

  return {
    begin: async ({ taskId, token, generation, workspaceRoot }) => {
      const previous = tokenByTask.get(taskId);
      if (previous && previous !== token) {
        const old = byToken.get(previous);
        // A newer generation owns the task. Revoking stops any further report or
        // action from being authoritative; quarantining the old workspace also
        // removes the path a still-running adapter would keep using, even if it
        // never reaches the runner's abandonment callback.
        if (old) {
          revoke(old);
          await quarantineRunWorkspace({
            root: old.workspaceRoot,
            suffix: input.clock.now().getTime().toString(),
          });
        }
      }
      const capability: RunCapability = {
        taskId,
        token,
        generation,
        workspaceRoot,
        revoked: false,
      };
      byToken.set(token, capability);
      tokenByTask.set(taskId, token);
      return capability;
    },

    isLive: (taskId, token) => {
      const capability = byToken.get(token);
      return capability !== undefined && !capability.revoked && capability.taskId === taskId;
    },

    get: (token) => byToken.get(token) ?? null,

    finish: (taskId, token) => {
      const capability = byToken.get(token);
      if (capability && capability.taskId === taskId) revoke(capability);
    },

    abandon: async ({ taskId, token, reason: _reason }) => {
      const capability = byToken.get(token);
      if (!capability) return false;
      if (taskId !== undefined && capability.taskId !== taskId) return false;
      revoke(capability);
      await quarantineRunWorkspace({
        root: capability.workspaceRoot,
        suffix: input.clock.now().getTime().toString(),
      });
      return true;
    },

    live: () => [...byToken.values()].filter((capability) => !capability.revoked),

    shutdown: async () => {
      const capabilities = [...byToken.values()];
      let quarantined = 0;
      for (const capability of capabilities) {
        revoke(capability);
        if (
          await quarantineRunWorkspace({
            root: capability.workspaceRoot,
            suffix: input.clock.now().getTime().toString(),
          })
        ) {
          quarantined += 1;
        }
      }
      byToken.clear();
      tokenByTask.clear();
      return { revoked: capabilities.length, quarantined };
    },
  };
}
