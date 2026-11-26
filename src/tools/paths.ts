import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * File tools receive a path from a model, so confinement is enforced here rather
 * than trusted to each tool. The check resolves symlinks on both the root and the
 * existing part of the candidate: a link inside the workspace that points outside
 * it is rejected, and an absolute path is rejected outright so one tool call
 * cannot name a host directory.
 */

const isWindows = process.platform === 'win32';

function normalize(value: string): string {
  const resolved = path.resolve(value);
  return isWindows ? resolved.toLowerCase() : resolved;
}

export function isInside(candidate: string, root: string): boolean {
  const left = normalize(candidate);
  const right = normalize(root);
  return left === right || left.startsWith(right.endsWith(path.sep) ? right : right + path.sep);
}

export type ConfinedPath = { ok: true; path: string; relative: string } | { ok: false; detail: string };

export async function confinePath(workspaceRoot: string, requested: string): Promise<ConfinedPath> {
  if (requested.length === 0 || requested.length > 1024) {
    return { ok: false, detail: 'The path must contain 1–1024 characters.' };
  }
  if (path.isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested)) {
    return { ok: false, detail: 'Absolute paths are not allowed; name a path inside the workspace.' };
  }
  const rootReal = await realpath(workspaceRoot).catch(() => null);
  if (!rootReal) return { ok: false, detail: 'The workspace is unavailable.' };

  const candidate = path.resolve(rootReal, requested);
  if (!isInside(candidate, rootReal)) {
    return { ok: false, detail: 'That path escapes the workspace.' };
  }

  // Resolve the existing part. A write target may not exist yet, so its parent is
  // what must be inside the workspace after symlink resolution.
  let existing = candidate;
  for (let depth = 0; depth < 64; depth += 1) {
    const resolved = await realpath(existing).catch(() => null);
    if (resolved) {
      if (!isInside(resolved, rootReal)) {
        return { ok: false, detail: 'That path resolves outside the workspace.' };
      }
      break;
    }
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }

  return {
    ok: true,
    path: candidate,
    relative: path.relative(rootReal, candidate).split(path.sep).join('/') || '.',
  };
}
