import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DataMode } from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * Owner-scoped artifact storage.
 *
 * Artifacts are written under the mode's workspace root, addressed by a hash of
 * the owner identity so one owner can never name another's directory, and every
 * path is resolved and checked to stay inside that owner's tree. Digests are
 * computed here so a task result can name the exact bytes it produced.
 */

export type ArtifactRecord = {
  path: string;
  bytes: number;
  digest: string;
};

export type ArtifactStore = {
  write: (input: {
    ownerId: string;
    mode: DataMode;
    path: string;
    bytes: Buffer;
  }) => Promise<ServiceResult<ArtifactRecord>>;
  read: (input: { ownerId: string; mode: DataMode; path: string }) => Promise<ServiceResult<Buffer>>;
  list: (input: { ownerId: string; mode: DataMode; prefix?: string }) => Promise<ArtifactRecord[]>;
  absolute: (input: { ownerId: string; mode: DataMode; path: string }) => string | null;
};

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

function ownerKey(ownerId: string): string {
  return createHash('sha256').update(ownerId).digest('hex').slice(0, 32);
}

function safeRelative(value: string): string | null {
  if (value.length === 0 || value.length > 300) return null;
  if (value.includes('\\') || value.includes('\0')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) return null;
  return normalized;
}

export function createArtifactStore(input: { roots: Record<DataMode, string> }): ArtifactStore {
  function ownerRoot(ownerId: string, mode: DataMode): string {
    return path.join(input.roots[mode], 'artifacts', ownerKey(ownerId));
  }

  function resolve(input: { ownerId: string; mode: DataMode; path: string }): string | null {
    const relative = safeRelative(input.path);
    if (!relative) return null;
    const root = ownerRoot(input.ownerId, input.mode);
    const absolute = path.resolve(root, relative);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    return absolute.startsWith(prefix) ? absolute : null;
  }

  return {
    absolute: (request) => resolve(request),
    write: async (request) => {
      if (request.bytes.length > MAX_ARTIFACT_BYTES) {
        return fail('validation_failed', 'The artifact exceeds the 8 MiB limit.');
      }
      const absolute = resolve(request);
      if (!absolute) return fail('validation_failed', 'The artifact path is not permitted.');
      try {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, request.bytes);
      } catch {
        return fail('internal_error', 'The artifact could not be written.');
      }
      return ok({
        path: safeRelative(request.path) as string,
        bytes: request.bytes.length,
        digest: createHash('sha256').update(request.bytes).digest('hex'),
      });
    },
    read: async (request) => {
      const absolute = resolve(request);
      if (!absolute) return fail('validation_failed', 'The artifact path is not permitted.');
      try {
        return ok(await readFile(absolute));
      } catch {
        return fail('not_found', 'That artifact does not exist for this owner.');
      }
    },
    list: async (request) => {
      const root = ownerRoot(request.ownerId, request.mode);
      const prefix = request.prefix ? safeRelative(request.prefix) : '';
      if (prefix === null) return [];
      const base = prefix ? path.join(root, prefix) : root;
      const records: ArtifactRecord[] = [];
      async function walk(directory: string, relative: string): Promise<void> {
        let entries: string[];
        try {
          entries = await readdir(directory);
        } catch {
          return;
        }
        for (const entry of entries.sort()) {
          const absolute = path.join(directory, entry);
          const next = relative ? `${relative}/${entry}` : entry;
          const info = await stat(absolute).catch(() => null);
          if (!info) continue;
          if (info.isDirectory()) {
            await walk(absolute, next);
            continue;
          }
          const bytes = await readFile(absolute).catch(() => null);
          if (!bytes) continue;
          records.push({
            path: next,
            bytes: bytes.length,
            digest: createHash('sha256').update(bytes).digest('hex'),
          });
        }
      }
      await walk(base, prefix);
      return records;
    },
  };
}
