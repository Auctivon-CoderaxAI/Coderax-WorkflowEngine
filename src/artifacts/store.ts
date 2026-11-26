import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ArtifactRow } from '../domain.js';
import type { DataMode } from '@coderax/contracts';
import type { WorkspaceRoots } from '../execution/workspace.js';

/**
 * Artifact metadata and bytes.
 *
 * Metadata is owner-scoped and durable. Bytes live under an engine-managed
 * directory inside the mode's workspace root, addressed by the generated
 * artifact id rather than by the caller's `path` label, so no request can choose
 * a filesystem location. The digest is computed on write and re-verified on read.
 */
export type ArtifactRepository = {
  insert: (row: ArtifactRow) => Promise<void>;
  get: (ownerId: string, artifactId: string) => Promise<ArtifactRow | null>;
  list: (ownerId: string, taskId: string) => Promise<ArtifactRow[]>;
};

export function createArtifactRepository(): ArtifactRepository {
  const rows = new Map<string, ArtifactRow>();

  return {
    insert: async (row) => {
      rows.set(row.artifactId, { ...row });
    },
    get: async (ownerId, artifactId) => {
      const row = rows.get(artifactId);
      return row && row.ownerId === ownerId ? { ...row } : null;
    },
    list: async (ownerId, taskId) =>
      [...rows.values()]
        .filter((row) => row.ownerId === ownerId && row.taskId === taskId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((row) => ({ ...row })),
  };
}

export function digestOf(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export type ArtifactStorage = {
  write: (input: { mode: DataMode; artifactId: string; content: Buffer }) => Promise<{
    bytes: number;
    digest: string;
  }>;
  read: (input: { mode: DataMode; artifactId: string; digest: string }) => Promise<Buffer>;
  remove: (input: { mode: DataMode; artifactId: string }) => Promise<void>;
};

const ARTIFACT_DIRECTORY = '.coderax-artifacts';

function directoryFor(roots: WorkspaceRoots, mode: DataMode): string {
  return path.resolve(roots[mode], ARTIFACT_DIRECTORY);
}

function fileFor(roots: WorkspaceRoots, mode: DataMode, artifactId: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(artifactId)) {
    throw new Error('artifact identity is not a safe file name');
  }
  const directory = directoryFor(roots, mode);
  const candidate = path.resolve(directory, `${artifactId}.bin`);
  if (!candidate.startsWith(directory + path.sep)) {
    throw new Error('artifact path escaped its root');
  }
  return candidate;
}

export function createArtifactStorage(roots: WorkspaceRoots): ArtifactStorage {
  return {
    write: async ({ mode, artifactId, content }) => {
      const directory = directoryFor(roots, mode);
      await mkdir(directory, { recursive: true });
      const digest = digestOf(content);
      await writeFile(fileFor(roots, mode, artifactId), content, { mode: 0o600 });
      return { bytes: content.length, digest };
    },
    read: async ({ mode, artifactId, digest }) => {
      const content = await readFile(fileFor(roots, mode, artifactId));
      if (digestOf(content) !== digest) {
        throw new Error('stored artifact does not match its recorded digest');
      }
      return content;
    },
    remove: async ({ mode, artifactId }) => {
      await rm(fileFor(roots, mode, artifactId), { force: true });
    },
  };
}
