import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
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
 * The directory one conversation may write.
 *
 * Two runs in the same data mode used to share the mode root, so a run could read
 * another conversation's files and a quarantine had to take the whole mode out of
 * service. The path is derived here from the conversation id through a digest; a
 * caller never supplies it, and it cannot escape its mode root through a symlink
 * because the resolved directory is checked again after creation.
 *
 * The directory is per conversation, not per generation, so a resume continues in
 * the same place a previous generation wrote.
 */
export async function resolveConversationWorkspace(input: {
  mode: DataMode;
  roots: WorkspaceRoots;
  conversationId: string;
}): Promise<ServiceResult<ResolvedWorkspace>> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.conversationId)) {
    return fail('workspace_denied', 'That conversation id cannot name a workspace.');
  }
  const base = await resolveEngineWorkspace({ mode: input.mode, roots: input.roots });
  if (!base.ok) return base;

  const digest = createHash('sha256').update(input.conversationId, 'utf8').digest('hex');
  const candidate = path.join(base.value.confinement, 'conversations', digest.slice(0, 32));
  try {
    await mkdir(candidate, { recursive: true, mode: 0o700 });
  } catch {
    return fail('workspace_denied', 'The conversation workspace could not be created.');
  }

  const resolved = await realOrNull(candidate);
  if (!resolved || !isInside(resolved, base.value.confinement) || resolved === base.value.confinement) {
    return fail('workspace_denied', 'The conversation workspace is outside its data mode root.');
  }
  return ok({ mode: input.mode, root: resolved, confinement: base.value.confinement });
}
