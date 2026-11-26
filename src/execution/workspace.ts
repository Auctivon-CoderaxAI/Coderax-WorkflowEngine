import { realpath } from 'node:fs/promises';
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

const isWindows = process.platform === 'win32';

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
