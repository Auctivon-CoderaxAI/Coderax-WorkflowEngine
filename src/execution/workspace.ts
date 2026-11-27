import { chmod, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DataMode } from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * A workspace root is the only filesystem authority an execution engine gets.
 *
 * Both the requested directory and its mode root are resolved through symlinks,
 * so a link that points into the other mode is rejected rather than followed. The
 * two mode roots must exist, be absolute, be distinct and not contain one
 * another; overlapping roots would let one mode read the other's files.
 *
 * A run never receives the mode root itself. `createRunWorkspace` creates a
 * dedicated directory for one task and one generation, so two runs in the same
 * mode cannot read or overwrite each other's files. That is also what makes it
 * safe to revoke one run: `quarantineRunWorkspace` renames only that run's
 * directory, leaving every other run untouched.
 */

export type WorkspaceRoots = Record<DataMode, string>;

/** Maps the configuration field names onto the engine's mode roots once. */
export function workspaceRoots(config: {
  privateRoot: string;
  cloudRoot: string;
}): WorkspaceRoots {
  return { private: config.privateRoot, cloud: config.cloudRoot };
}

export type ResolvedWorkspace = {
  mode: DataMode;
  root: string;
  confinement: string;
};

export type RunWorkspace = ResolvedWorkspace & {
  /** The mode root this run is confined to. */
  parent: string;
  runId: string;
  generation: number;
};

const isWindows = process.platform === 'win32';

/** A run id becomes a directory name, so it is an allow-list, not a filter. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const RUN_DIR = '.coderax-runs';
const QUARANTINE_DIR = '.coderax-quarantine';

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return isWindows ? resolved.toLowerCase() : resolved;
}

function isInside(candidate: string, parent: string): boolean {
  const left = normalize(candidate);
  const right = normalize(parent);
  return left === right || left.startsWith(right.endsWith(path.sep) ? right : right + path.sep);
}

async function realOrNull(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

export async function validateWorkspaceRoots(
  roots: WorkspaceRoots,
): Promise<ServiceResult<WorkspaceRoots>> {
  if (!path.isAbsolute(roots.private) || !path.isAbsolute(roots.cloud)) {
    return fail('engine_not_configured', 'Workspace roots must be absolute paths.');
  }
  const privateRoot = await realOrNull(roots.private);
  const cloudRoot = await realOrNull(roots.cloud);
  if (!privateRoot || !cloudRoot) {
    return fail('engine_not_configured', 'A configured workspace root does not exist.');
  }
  if (isInside(privateRoot, cloudRoot) || isInside(cloudRoot, privateRoot)) {
    return fail('engine_not_configured', 'Private and cloud workspace roots must not overlap.');
  }
  return ok({ private: privateRoot, cloud: cloudRoot });
}

/**
 * Resolves the mode root itself. Retained for callers that only need to prove a
 * mode is usable; an execution must use `createRunWorkspace` instead.
 */
export async function resolveEngineWorkspace(input: {
  mode: DataMode;
  roots: WorkspaceRoots;
}): Promise<ServiceResult<ResolvedWorkspace>> {
  const confinement = await realOrNull(input.roots[input.mode]);
  if (!confinement) {
    return fail(
      'engine_not_configured',
      'The workspace root for this data mode is unavailable.',
    );
  }
  const otherMode: DataMode = input.mode === 'private' ? 'cloud' : 'private';
  const other = await realOrNull(input.roots[otherMode]);
  if (other && (isInside(confinement, other) || isInside(other, confinement))) {
    return fail('engine_not_configured', 'Configured workspace roots overlap.');
  }
  if (other && isInside(confinement, other)) {
    return fail('workspace_denied', 'The workspace belongs to another data mode.');
  }
  return ok({ mode: input.mode, root: confinement, confinement });
}

/**
 * Creates the sole directory one task generation may touch.
 *
 * The directory is a child of the mode root, never the root itself, and it is
 * created private (0700). The resolved path is checked again after creation, so
 * a pre-existing symlink in the run directory cannot redirect writes into the
 * other mode.
 */
export async function createRunWorkspace(input: {
  mode: DataMode;
  roots: WorkspaceRoots;
  runId: string;
  generation: number;
}): Promise<ServiceResult<RunWorkspace>> {
  if (!RUN_ID.test(input.runId)) {
    return fail('workspace_denied', 'The run identity is not a valid workspace name.');
  }
  if (!Number.isInteger(input.generation) || input.generation < 0 || input.generation > 1_000_000) {
    return fail('workspace_denied', 'The run generation is not a valid workspace name.');
  }

  const parent = await resolveEngineWorkspace(input);
  if (!parent.ok) return parent;

  const base = path.join(parent.value.confinement, RUN_DIR);
  const root = path.join(base, `${input.runId}-g${input.generation}`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
  } catch {
    return fail('workspace_denied', 'The run workspace could not be created.');
  }

  const resolved = await realOrNull(root);
  if (!resolved) {
    return fail('workspace_denied', 'The run workspace is unavailable.');
  }
  if (!isInside(resolved, parent.value.confinement) || normalize(resolved) === normalize(parent.value.confinement)) {
    return fail('workspace_denied', 'The run workspace escapes its data mode.');
  }

  return ok({
    mode: input.mode,
    root: resolved,
    confinement: resolved,
    parent: parent.value.confinement,
    runId: input.runId,
    generation: input.generation,
  });
}

/**
 * Removes a run's authority at the filesystem level.
 *
 * The engine cannot kill code that ignored its abort, but it can make the only
 * path that code was given stop existing. The directory is renamed into a
 * quarantine area on the same filesystem and made read-only, so a stale writer
 * either gets ENOENT or cannot create anything new. Returns true when the path
 * was revoked by this call.
 */
export async function quarantineRunWorkspace(input: {
  root: string;
  suffix?: string;
}): Promise<boolean> {
  const base = path.dirname(input.root);
  // Only a directory this module created is eligible. Nothing else is renamed.
  if (path.basename(base) !== RUN_DIR) return false;

  const modeRoot = path.dirname(base);
  const quarantine = path.join(modeRoot, QUARANTINE_DIR);
  const suffix = input.suffix ?? `${Date.now()}`;
  try {
    await realpath(input.root);
  } catch {
    return false;
  }

  try {
    await mkdir(quarantine, { recursive: true, mode: 0o700 });
    await chmod(quarantine, 0o700);
    await rename(input.root, path.join(quarantine, `${path.basename(input.root)}-${suffix}`));
  } catch {
    // A rename can fail if the directory is gone or the volume refused it. In
    // that case removing every permission is still a fail-closed revocation.
    await chmod(input.root, 0o000).catch(() => undefined);
    return false;
  }
  await chmod(path.join(quarantine, `${path.basename(input.root)}-${suffix}`), 0o500).catch(
    () => undefined,
  );
  return true;
}

/** Deletes an empty run directory; a run that produced artifacts keeps them. */
export async function removeRunWorkspaceIfEmpty(root: string): Promise<boolean> {
  try {
    const entries = await readdir(root);
    if (entries.length > 0) return false;
    await rm(root, { recursive: false, force: true });
    return true;
  } catch {
    return false;
  }
}
