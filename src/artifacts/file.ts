import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type WrittenFile = { path: string; bytes: number; sha256: string };

/** A relative artifact path that cannot leave the confined workspace root. */
export class ArtifactPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPathError';
  }
}

/** Lowercase hex, the one digest convention the artifact contract uses. */
export function digestOf(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function isInside(candidate: string, parent: string): boolean {
  const left = path.resolve(candidate);
  const right = path.resolve(parent);
  return left === right || left.startsWith(right.endsWith(path.sep) ? right : right + path.sep);
}

/**
 * Resolves a workspace-relative path and refuses anything that escapes the root.
 * The check is on the resolved path, not on the input string, so `a/../../b` and
 * an absolute path both fail for the same reason.
 */
export function resolveInside(root: string, relative: string): string {
  if (!path.isAbsolute(root)) {
    throw new ArtifactPathError('The workspace root is not absolute.');
  }
  if (relative.length === 0 || relative.includes('\0') || relative.includes('\\')) {
    throw new ArtifactPathError('The requested path is not a valid relative path.');
  }
  if (path.isAbsolute(relative)) {
    throw new ArtifactPathError('The requested path must be relative to the workspace.');
  }
  const resolved = path.resolve(root, relative);
  if (!isInside(resolved, root) || resolved === path.resolve(root)) {
    throw new ArtifactPathError('The requested path leaves the workspace.');
  }
  return resolved;
}

export async function writeArtifact(input: {
  root: string;
  relative: string;
  data: Buffer | string;
}): Promise<WrittenFile> {
  const data = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : input.data;
  const absolute = resolveInside(input.root, input.relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, data);
  return {
    path: input.relative,
    bytes: data.length,
    sha256: digestOf(data),
  };
}

export async function readArtifact(input: {
  root: string;
  relative: string;
  limit?: number;
}): Promise<Buffer> {
  const absolute = resolveInside(input.root, input.relative);
  const data = await readFile(absolute);
  const limit = input.limit ?? 8 * 1024 * 1024;
  if (data.length > limit) {
    throw new ArtifactPathError('The requested file exceeds the readable size limit.');
  }
  return data;
}

export function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}
