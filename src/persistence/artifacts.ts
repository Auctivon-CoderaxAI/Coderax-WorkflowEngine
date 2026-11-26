import type { ArtifactKind, DataMode } from '@coderax/contracts';
import type { ArtifactRecord, ArtifactVersionRecord } from '../domain.js';

/**
 * The authoritative artifact metadata store.
 *
 * Every lookup takes the owner and the data mode as part of the identity, so a
 * private artifact cannot be reached through a cloud request (or the reverse)
 * even with a known artifact id. Versions are immutable rows; the artifact
 * document only names the current one.
 */
export type ArtifactKey = {
  ownerId: string;
  mode: DataMode;
  artifactId: string;
};

export type ArtifactListFilter = {
  mode: DataMode;
  kind?: ArtifactKind;
  projectId?: string;
  conversationId?: string;
  taskId?: string;
  limit: number;
};

export type ArtifactUsage = { bytes: number; artifacts: number };

export type CreateArtifactOutcome =
  | { ok: true; artifact: ArtifactRecord; version: ArtifactVersionRecord }
  | { ok: false; reason: 'exists' };

export type AppendVersionOutcome =
  | { ok: true; artifact: ArtifactRecord; version: ArtifactVersionRecord }
  | { ok: false; reason: 'not_found' | 'conflict' };

export type RemoveArtifactOutcome = {
  artifact: ArtifactRecord | null;
  versions: ArtifactVersionRecord[];
};

export type ArtifactRepository = {
  create: (input: {
    artifact: ArtifactRecord;
    version: ArtifactVersionRecord;
  }) => Promise<CreateArtifactOutcome>;
  /** Appends only when the stored artifact is still at `expectedVersion`. */
  appendVersion: (input: {
    artifact: ArtifactRecord;
    expectedVersion: number;
    version: ArtifactVersionRecord;
  }) => Promise<AppendVersionOutcome>;
  get: (key: ArtifactKey) => Promise<ArtifactRecord | null>;
  list: (ownerId: string, filter: ArtifactListFilter) => Promise<ArtifactRecord[]>;
  versions: (key: ArtifactKey) => Promise<ArtifactVersionRecord[]>;
  version: (input: ArtifactKey & { version: number }) => Promise<ArtifactVersionRecord | null>;
  usage: (input: { ownerId: string; mode: DataMode }) => Promise<ArtifactUsage>;
  /** True while any retained version still points at the digest. */
  referenced: (input: { ownerId: string; mode: DataMode; sha256: string }) => Promise<boolean>;
  remove: (key: ArtifactKey) => Promise<RemoveArtifactOutcome>;
  /** Removes an older version only; the current version is never removable. */
  removeVersion: (
    input: ArtifactKey & { version: number },
  ) => Promise<ArtifactVersionRecord | null>;
  /**
   * Reverses an append that a post-write quota check refused: removes the
   * current version and points the artifact back at the newest remaining one.
   */
  rollbackVersion: (
    input: ArtifactKey & { version: number },
  ) => Promise<ArtifactVersionRecord | null>;
  listExpired: (input: {
    now: string;
    limit: number;
    ownerId?: string;
    mode?: DataMode;
  }) => Promise<ArtifactRecord[]>;
};

function partition(key: ArtifactKey): string {
  return `${key.ownerId}\u0000${key.mode}\u0000${key.artifactId}`;
}

export function createArtifactRepository(): ArtifactRepository {
  const artifacts = new Map<string, ArtifactRecord>();
  const versions = new Map<string, Map<number, ArtifactVersionRecord>>();

  function versionsFor(key: string): Map<number, ArtifactVersionRecord> {
    const existing = versions.get(key);
    if (existing) return existing;
    const created = new Map<number, ArtifactVersionRecord>();
    versions.set(key, created);
    return created;
  }

  function matches(record: ArtifactRecord, filter: ArtifactListFilter): boolean {
    if (record.mode !== filter.mode) return false;
    if (filter.kind && record.kind !== filter.kind) return false;
    if (filter.projectId && record.projectId !== filter.projectId) return false;
    if (filter.conversationId && record.conversationId !== filter.conversationId) return false;
    if (filter.taskId && record.taskId !== filter.taskId) return false;
    return true;
  }

  return {
    create: async ({ artifact, version }) => {
      const key = partition(artifact);
      if (artifacts.has(key)) return { ok: false, reason: 'exists' };
      artifacts.set(key, { ...artifact });
      versionsFor(key).set(version.version, { ...version });
      return { ok: true, artifact: { ...artifact }, version: { ...version } };
    },

    appendVersion: async ({ artifact, expectedVersion, version }) => {
      const key = partition(artifact);
      const current = artifacts.get(key);
      if (!current) return { ok: false, reason: 'not_found' };
      if (current.version !== expectedVersion) return { ok: false, reason: 'conflict' };
      const rows = versionsFor(key);
      if (rows.has(version.version)) return { ok: false, reason: 'conflict' };
      rows.set(version.version, { ...version });
      artifacts.set(key, { ...artifact });
      return { ok: true, artifact: { ...artifact }, version: { ...version } };
    },

    get: async (key) => {
      const record = artifacts.get(partition(key));
      return record ? { ...record } : null;
    },

    list: async (ownerId, filter) =>
      [...artifacts.values()]
        .filter((record) => record.ownerId === ownerId && matches(record, filter))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, filter.limit)
        .map((record) => ({ ...record })),

    versions: async (key) => {
      const rows = versions.get(partition(key));
      if (!rows) return [];
      return [...rows.values()].sort((left, right) => left.version - right.version).map((row) => ({
        ...row,
      }));
    },

    version: async (input) => {
      const row = versions.get(partition(input))?.get(input.version);
      return row ? { ...row } : null;
    },

    usage: async ({ ownerId, mode }) => {
      let bytes = 0;
      for (const rows of versions.values()) {
        for (const row of rows.values()) {
          if (row.ownerId === ownerId && row.mode === mode) bytes += row.bytes;
        }
      }
      const count = [...artifacts.values()].filter(
        (record) => record.ownerId === ownerId && record.mode === mode,
      ).length;
      return { bytes, artifacts: count };
    },

    referenced: async ({ ownerId, mode, sha256 }) => {
      for (const rows of versions.values()) {
        for (const row of rows.values()) {
          if (row.ownerId === ownerId && row.mode === mode && row.sha256 === sha256) return true;
        }
      }
      return false;
    },

    remove: async (key) => {
      const id = partition(key);
      const artifact = artifacts.get(id) ?? null;
      const rows = versions.get(id);
      artifacts.delete(id);
      versions.delete(id);
      return {
        artifact: artifact ? { ...artifact } : null,
        versions: rows ? [...rows.values()].map((row) => ({ ...row })) : [],
      };
    },

    removeVersion: async (input) => {
      const id = partition(input);
      const artifact = artifacts.get(id);
      if (!artifact) return null;
      if (input.version >= artifact.version) return null;
      const rows = versions.get(id);
      const row = rows?.get(input.version);
      if (!rows || !row) return null;
      rows.delete(input.version);
      artifacts.set(id, { ...artifact, versions: Math.max(1, artifact.versions - 1) });
      return { ...row };
    },

    rollbackVersion: async (input) => {
      const id = partition(input);
      const artifact = artifacts.get(id);
      if (!artifact || artifact.version !== input.version) return null;
      const rows = versions.get(id);
      const row = rows?.get(input.version);
      if (!rows || !row) return null;
      rows.delete(input.version);
      const remaining = [...rows.values()].sort((left, right) => right.version - left.version);
      const newest = remaining[0];
      if (!newest) {
        artifacts.delete(id);
        versions.delete(id);
        return { ...row };
      }
      artifacts.set(id, {
        ...artifact,
        kind: newest.kind,
        filename: newest.filename,
        mediaType: newest.mediaType,
        bytes: newest.bytes,
        sha256: newest.sha256,
        version: newest.version,
        versions: remaining.length,
        updatedAt: newest.createdAt,
      });
      return { ...row };
    },

    listExpired: async ({ now, limit, ownerId, mode }) =>
      [...artifacts.values()]
        .filter((record) => {
          if (record.expiresAt === null) return false;
          if (record.expiresAt > now) return false;
          if (ownerId && record.ownerId !== ownerId) return false;
          if (mode && record.mode !== mode) return false;
          return true;
        })
        .sort((left, right) => (left.expiresAt ?? '').localeCompare(right.expiresAt ?? ''))
        .slice(0, limit)
        .map((record) => ({ ...record })),
  };
}
