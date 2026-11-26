import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactDescriptor } from '@coderax/contracts';

/**
 * A source tree is a project, not a list of unrelated files.
 *
 * Every file is stored as a durable artifact with a validated `relativePath` and
 * a shared `projectId`; this manifest records the artifact identity, digest and
 * retained version so a client can reconstruct the tree by artifact ID alone.
 * The manifest carries no filesystem destination: restoration validates every
 * path before it is joined to the caller's root.
 */

export type TreeFile = {
  relativePath: string;
  artifactId: string;
  filename: string;
  mediaType: string;
  kind: string;
  bytes: number;
  sha256: string;
  version: number;
};

export type TreeManifest = {
  version: 1;
  projectId: string;
  name: string;
  entry: string;
  createdAt: string;
  files: TreeFile[];
};

export class TreePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreePathError';
  }
}

/** Rejects any path that could escape the restoration root or collide. */
export function safeRelativePath(relativePath: string): string {
  const normalized = relativePath.normalize('NFC');
  if (normalized.length === 0 || normalized.length > 1024) {
    throw new TreePathError('A tree path must be between 1 and 1024 characters.');
  }
  if (
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('\\') ||
    /^[A-Za-z]:/.test(normalized) ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new TreePathError('A tree path must be relative, use forward slashes and contain no control characters.');
  }
  const segments = normalized.split('/');
  if (segments.length > 64) throw new TreePathError('A tree path has too many segments.');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new TreePathError('A tree path must not contain empty, dot or parent segments.');
    }
    if (segment !== segment.trim() || segment.startsWith('.') || segment.endsWith('.')) {
      throw new TreePathError('A tree path segment must not start or end with a dot or whitespace.');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) {
      throw new TreePathError('A tree path must not use a reserved device name.');
    }
  }
  return normalized;
}

export function manifestFor(input: {
  projectId: string;
  name: string;
  entry: string;
  createdAt: string;
  artifacts: Array<{ relativePath: string; descriptor: ArtifactDescriptor }>;
}): TreeManifest {
  const seen = new Set<string>();
  const files: TreeFile[] = [];
  for (const entry of input.artifacts) {
    const relativePath = safeRelativePath(entry.relativePath);
    if (seen.has(relativePath.toLowerCase())) {
      throw new TreePathError(`The tree contains the same path twice: ${relativePath}`);
    }
    seen.add(relativePath.toLowerCase());
    if (path.posix.basename(relativePath) !== entry.descriptor.filename) {
      throw new TreePathError('A tree path must end with the artifact filename.');
    }
    files.push({
      relativePath,
      artifactId: entry.descriptor.artifactId,
      filename: entry.descriptor.filename,
      mediaType: entry.descriptor.mediaType,
      kind: entry.descriptor.kind,
      bytes: entry.descriptor.bytes,
      sha256: entry.descriptor.sha256,
      version: entry.descriptor.version,
    });
  }
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
  return {
    version: 1,
    projectId: input.projectId,
    name: input.name,
    entry: safeRelativePath(input.entry),
    createdAt: input.createdAt,
    files,
  };
}

/**
 * Reconstructs a tree from a manifest. Metadata is untrusted input: each path is
 * revalidated, the joined destination must remain inside `root`, duplicate paths
 * are refused, and every byte is checked against the recorded digest before the
 * file is created with `wx` so a symlink or existing file is never overwritten.
 */
export async function restoreTree(input: {
  root: string;
  manifest: TreeManifest;
  read: (artifactId: string, version: number) => Promise<Buffer>;
}): Promise<{ files: number; bytes: number }> {
  if (input.manifest.version !== 1) {
    throw new TreePathError('The tree manifest version is not supported.');
  }
  if (!input.manifest.projectId) {
    throw new TreePathError('The tree manifest is missing its project identity.');
  }
  const root = path.resolve(input.root);
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const entry of input.manifest.files) {
    const relativePath = safeRelativePath(entry.relativePath);
    if (seen.has(relativePath.toLowerCase())) {
      throw new TreePathError(`The tree manifest repeats a path: ${relativePath}`);
    }
    seen.add(relativePath.toLowerCase());
    if (path.posix.basename(relativePath) !== entry.filename) {
      throw new TreePathError('A tree entry filename does not match its relative path.');
    }
    const content = await input.read(entry.artifactId, entry.version);
    if (content.length !== entry.bytes) {
      throw new TreePathError(`The artifact byte count changed for ${relativePath}.`);
    }
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== entry.sha256) {
      throw new TreePathError(`The artifact digest does not match for ${relativePath}.`);
    }
    const destination = path.resolve(root, ...relativePath.split('/'));
    if (destination !== root && !destination.startsWith(root + path.sep)) {
      throw new TreePathError('A tree path escapes the restoration root.');
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx' });
    files += 1;
    bytes += content.length;
  }
  return { files, bytes };
}

/** Rebuilds a manifest from durable descriptors listed by project. */
export function manifestFromDescriptors(input: {
  projectId: string;
  name: string;
  entry: string;
  createdAt: string;
  descriptors: ArtifactDescriptor[];
}): TreeManifest {
  const artifacts = input.descriptors
    .filter((descriptor) => descriptor.relativePath !== undefined)
    .map((descriptor) => ({ relativePath: descriptor.relativePath as string, descriptor }));
  return manifestFor({ ...input, artifacts });
}
