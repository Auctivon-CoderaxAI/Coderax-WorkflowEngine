import type { PermissionScope } from '@coderax/contracts';

/**
 * The authority a single execution holds over its tools.
 *
 * A guard is lent to the tool runtime for exactly one run. It answers two
 * questions that must not be conflated:
 *
 * - `live` is whether the execution still owns its authority at all. Once the
 *   run is cancelled, interrupted or superseded, every further tool call is
 *   refused, even if the adapter keeps looping because it ignored its abort.
 * - `permits` is whether this execution's grant covers one exact scope and
 *   resource. A grant names the workspace root, so a tool cannot widen it.
 *
 * `recordUse` exists for containment accounting: a run that exercised a tool
 * which can spawn a process cannot later be described as having started
 * nothing, so the supervisor refuses to claim verified termination for it.
 *
 * Revocation is a boundary at call entry, not a rollback. An in-flight write
 * cannot be recalled; what the guard guarantees is that no new call starts and
 * that the caller never applies the result of a revoked run.
 */
export type ToolExecutionGuard = {
  executionId: string;
  live: () => boolean;
  permits: (scope: PermissionScope, resource: string) => boolean;
  recordUse: (input: {
    scope: PermissionScope;
    resource: string;
    spawnsProcesses: boolean;
  }) => void;
};
