import type { DataMode } from '@coderax/contracts';
import type { ArtifactRecord, ArtifactVersionRecord } from '../domain.js';
import {
  artifactPathKey,
  type AppendVersionOutcome,
  type ArtifactKey,
  type ArtifactRepository,
  type ArtifactUsage,
  type CreateArtifactOutcome,
  type RemoveArtifactOutcome,
  type RestoreVersionOutcome,
} from './artifacts.js';
import { blobKey, BlobIntegrityError, verifyContent, type BlobStore } from './blobs.js';
import { isDuplicateKey, type MongoCollectionLike } from './mongo.js';
import { randomUUID } from 'node:crypto';
import type { Clock } from '../support/clock.js';

/**
 * Durable artifact metadata and content in MongoDB.
 *
 * This is the production path: the database the engine already uses for tasks,
 * conversations and leases also holds artifact descriptors, immutable version
 * rows and chunked content. It adds no storage vendor and no paid dependency,
 * and a restart or a second replica reads the same bytes because nothing here
 * lives in a process.
 *
 * Content is stored in fixed-size chunks under a key made from the owner, the
 * mode and the digest. MongoDB's per-document size limit therefore bounds a
 * chunk, not an artifact, and an artifact can never address storage outside its
 * own partition.
 */

export type MongoArtifactCollections = {
  artifacts: MongoCollectionLike;
  versions: MongoCollectionLike;
  blobs: MongoCollectionLike;
  chunks: MongoCollectionLike;
};

type Document = Record<string, unknown>;

function strip(document: Document): Document {
  const copy = { ...document };
  delete copy._id;
  delete copy.cleanup;
  delete copy.pruning;
  delete copy.expiresAtMs;
  return copy;
}

function toArtifact(document: Document): ArtifactRecord {
  if (
    typeof document.artifactId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.mode !== 'string' ||
    typeof document.sha256 !== 'string' ||
    typeof document.version !== 'number' ||
    typeof document.bytes !== 'number'
  ) {
    throw new Error('A stored artifact row is malformed.');
  }
  return strip(document) as unknown as ArtifactRecord;
}

function toVersion(document: Document): ArtifactVersionRecord {
  if (
    typeof document.artifactId !== 'string' ||
    typeof document.ownerId !== 'string' ||
    typeof document.mode !== 'string' ||
    typeof document.version !== 'number' ||
    typeof document.sha256 !== 'string'
  ) {
    throw new Error('A stored artifact version row is malformed.');
  }
  return strip(document) as unknown as ArtifactVersionRecord;
}

function artifactDocument(record: ArtifactRecord): Document {
  return {
    ...record,
    expiresAtMs: record.expiresAt === null ? null : Date.parse(record.expiresAt),
  };
}

export async function ensureArtifactIndexes(
  collections: MongoArtifactCollections,
): Promise<void> {
  const { artifacts, versions, blobs, chunks } = collections;
  await artifacts.createIndex(
    { ownerId: 1, mode: 1, artifactId: 1 },
    { unique: true, name: 'artifact_identity' },
  );
  await artifacts.createIndex(
    { ownerId: 1, mode: 1, updatedAt: -1 },
    { name: 'artifact_owner_updated' },
  );
  await artifacts.createIndex({ ownerId: 1, mode: 1, taskId: 1 }, { name: 'artifact_task' });
  await artifacts.createIndex(
    { ownerId: 1, mode: 1, conversationId: 1 },
    { name: 'artifact_conversation' },
  );
  await artifacts.createIndex(
    { ownerId: 1, mode: 1, projectId: 1 },
    { name: 'artifact_project' },
  );
  // A project path is unique per owner, mode and project. The partial filter
  // excludes flat artifacts (no relativePath); the case-folded pathKey makes
  // `README.md` and `readme.md` collide before a case-insensitive filesystem
  // ever sees them.
  await artifacts.createIndex(
    { ownerId: 1, mode: 1, projectId: 1, pathKey: 1 },
    {
      unique: true,
      name: 'artifact_project_path',
      partialFilterExpression: { relativePath: { $type: 'string' } },
    },
  );
  await artifacts.createIndex({ expiresAtMs: 1 }, { name: 'artifact_expiry' });
  await versions.createIndex(
    { ownerId: 1, mode: 1, artifactId: 1, version: 1 },
    { unique: true, name: 'artifact_version_identity' },
  );
  await versions.createIndex(
    { ownerId: 1, mode: 1, sha256: 1 },
    { name: 'artifact_version_digest' },
  );
  await blobs.createIndex({ key: 1 }, { unique: true, name: 'artifact_blob_key' });
  await blobs.createIndex(
    { refCount: 1, createdAtMs: 1 },
    { name: 'artifact_blob_references' },
  );
  await chunks.createIndex({ key: 1, index: 1 }, { unique: true, name: 'artifact_chunk_key' });
}

function identity(key: ArtifactKey): Document {
  return { ownerId: key.ownerId, mode: key.mode, artifactId: key.artifactId };
}

export function createMongoArtifactRepository(
  collections: MongoArtifactCollections,
): ArtifactRepository {
  const { artifacts, versions } = collections;

  return {
    create: async ({ artifact, version }): Promise<CreateArtifactOutcome> => {
      if (await artifacts.findOne(identity(artifact))) {
        return { ok: false, reason: 'exists' };
      }
      try {
        await artifacts.insertOne(artifactDocument(artifact));
      } catch (error) {
        if (isDuplicateKey(error)) return { ok: false, reason: 'exists' };
        throw error;
      }
      try {
        await versions.insertOne({ ...version });
      } catch (error) {
        await artifacts.deleteOne(identity(artifact)).catch(() => undefined);
        if (isDuplicateKey(error)) return { ok: false, reason: 'exists' };
        throw error;
      }
      return { ok: true, artifact, version };
    },

    appendVersion: async ({
      artifact,
      expectedVersion,
      version,
    }): Promise<AppendVersionOutcome> => {
      const key = identity(artifact);
      const stored = await artifacts.findOne(key);
      if (!stored) return { ok: false, reason: 'not_found' };
      const current = toArtifact(stored);
      if (current.version !== expectedVersion || artifact.versions !== current.versions + 1 ||
          (artifact.mutationRevision ?? 1) !== (current.mutationRevision ?? 0) + 1) return { ok: false, reason: 'conflict' };

      // The version number is part of the filter: two replicas that both read
      // version N cannot both write N+1.
      let updated: { matchedCount?: number; upsertedCount?: number };
      try {
        updated = await artifacts.updateOne(
          { ...key, cleanup: { $exists: false }, version: expectedVersion, mutationRevision: current.mutationRevision ?? { $exists: false }, versions: current.versions },
          { $set: artifactDocument(artifact) },
          { upsert: false },
        );
      } catch (error) {
        // The project-path unique index is the race arbiter. A concurrent file
        // at the same case-folded path is a conflict, not an ambiguous write.
        if (isDuplicateKey(error)) return { ok: false, reason: 'conflict' };
        throw error;
      }
      if ((updated.matchedCount ?? 0) !== 1) return { ok: false, reason: 'conflict' };

      try {
        await versions.insertOne({ ...version });
      } catch (error) {
        await artifacts
          .updateOne(
            { ...key, version: artifact.version },
            {
              $set: {
                version: current.version,
                versions: current.versions,
                bytes: current.bytes,
                sha256: current.sha256,
                filename: current.filename,
                relativePath: current.relativePath ?? null,
                mediaType: current.mediaType,
                kind: current.kind,
                updatedAt: current.updatedAt,
                expiresAt: current.expiresAt,
                expiresAtMs: current.expiresAt === null ? null : Date.parse(current.expiresAt),
              },
            },
            { upsert: false },
          )
          .catch(() => undefined);
        if (isDuplicateKey(error)) return { ok: false, reason: 'conflict' };
        throw error;
      }
      return { ok: true, artifact, version };
    },

    get: async (key) => {
      const stored = await artifacts.findOne({ ...identity(key), cleanup: { $exists: false } });
      return stored ? toArtifact(stored) : null;
    },

    list: async (ownerId, filter) => {
      const { limit, ...criteria } = filter;
      const query = artifacts.find({ ownerId, ...criteria, cleanup: { $exists: false } }).sort({ updatedAt: -1 });
      if (limit !== undefined) query.limit(limit);
      return (await query.toArray()).map(toArtifact);
    },

    versions: async (key) => {
      const documents = await versions.find(identity(key)).sort({ version: 1 }).toArray();
      return documents.map(toVersion);
    },

    version: async (input) => {
      const stored = await versions.findOne({ ...identity(input), version: input.version });
      return stored ? toVersion(stored) : null;
    },

    usage: async ({ ownerId, mode }): Promise<ArtifactUsage> => {
      const filter = { ownerId, mode };
      const [totals, count] = await Promise.all([
        versions.aggregate([{ $match: filter }, { $group: { _id: null, bytes: { $sum: '$bytes' } } }]).toArray(),
        artifacts.countDocuments(filter),
      ]);
      return { bytes: Number(totals[0]?.bytes ?? 0), artifacts: count };
    },

    referenced: async ({ ownerId, mode, sha256 }) =>
      (await versions.findOne({ ownerId, mode, sha256 })) !== null,

    remove: async (key): Promise<RemoveArtifactOutcome> => {
      const id = identity(key);
      const stored = await artifacts.findOne({ ...id, cleanup: { $exists: false } });
      if (!stored) return { artifact: null, versions: [] };
      const rows = (await versions.find(id).sort({ version: 1 }).toArray()).map(toVersion);
      if (rows.length !== stored.versions || !rows.some(row => row.version === stored.version)) {
        throw new Error('Artifact history is changing during deletion');
      }
      // The descriptor itself is the durable cleanup journal. A crash at any
      // subsequent step leaves the version identities available to maintenance.
      const claimed = await artifacts.updateOne({ ...id, cleanup: { $exists: false },
        version: stored.version, versions: stored.versions,
        mutationRevision: stored.mutationRevision ?? { $exists: false } },
        { $set: { cleanup: rows } }, { upsert: false });
      if (!claimed.matchedCount) return { artifact: null, versions: [] };
      return { artifact: toArtifact(stored), versions: rows };
    },

    pendingRemovals: async (limit, partition) => {
      const rows = await artifacts.find({ ...partition, cleanup: { $exists: true } }).limit(limit).toArray();
      return rows.map(row => ({ artifact: toArtifact(row), versions: row.cleanup as ArtifactVersionRecord[] }));
    },

    finishRemoval: async key => {
      const id = identity(key);
      await versions.deleteMany(id);
      await artifacts.deleteOne({ ...id, cleanup: { $exists: true } });
    },

    removeVersion: async (input) => {
      const key = identity(input);
      const stored = await artifacts.findOne(key);
      if (!stored) return null;
      const artifact = toArtifact(stored);
      const pending = Array.isArray(stored.pruning) && stored.pruning.includes(input.version);
      if (!pending && input.version >= artifact.version) return null;
      const row = await versions.findOne({ ...key, version: input.version });
      if (!row) return null;
      const marker = { ...key, pruning: input.version };
      const claimed = await artifacts.updateOne(
        { ...key, cleanup: { $exists: false }, pruning: { $nin: [input.version] },
          version: artifact.version, versions: artifact.versions,
          mutationRevision: artifact.mutationRevision ?? { $exists: false } },
        { $push: { pruning: input.version }, $inc: { versions: -1, mutationRevision: 1 } },
        { upsert: false },
      );
      if (!claimed.matchedCount && !(await artifacts.findOne(marker))) return null;
      const deleted = await versions.deleteOne({ ...key, version: input.version });
      await artifacts.updateOne(marker, { $pull: { pruning: input.version } }, { upsert: false });
      if (!deleted.deletedCount) return null;
      return toVersion(row);
    },

    rollbackVersion: async (input) => {
      const key = identity(input);
      const stored = await artifacts.findOne(key);
      if (!stored) return null;
      const artifact = toArtifact(stored);
      if (artifact.version !== input.version) return null;
      const row = await versions.findOne({ ...key, version: input.version });
      if (!row) return null;
      await versions.deleteOne({ ...key, version: input.version });
      const remaining = await versions.find(key).sort({ version: -1 }).limit(1).toArray();
      const newest = remaining[0];
      if (!newest) {
        await artifacts.deleteOne(key);
        return toVersion(row);
      }
      const previous = toVersion(newest);
      await artifacts.updateOne(
        key,
        {
          $set: {
            kind: previous.kind,
            filename: previous.filename,
            relativePath: previous.relativePath ?? null,
            pathKey: previous.relativePath ? artifactPathKey(previous.relativePath) : null,
            mediaType: previous.mediaType,
            bytes: previous.bytes,
            sha256: previous.sha256,
            version: previous.version,
            versions: (await versions.find(key).toArray()).length,
            updatedAt: previous.createdAt,
          },
        },
        { upsert: false },
      );
      return toVersion(row);
    },

    restoreVersion: async (input): Promise<RestoreVersionOutcome> => {
      const key = identity(input);
      const stored = await artifacts.findOne(key);
      if (!stored) return { ok: false, reason: 'not_found' };
      const artifact = toArtifact(stored);
      if (artifact.version !== input.expectedVersion) {
        return { ok: false, reason: 'conflict' };
      }
      const row = await versions.findOne({ ...key, version: input.version });
      if (!row) return { ok: false, reason: 'not_found' };
      const target = toVersion(row);
      const updated = await artifacts.updateOne(
        { ...key, cleanup: { $exists: false }, pruning: { $nin: [input.version] }, version: input.expectedVersion, mutationRevision: artifact.mutationRevision ?? { $exists: false } },
        {
          $set: {
            kind: target.kind,
            filename: target.filename,
            relativePath: target.relativePath ?? null,
            pathKey: target.relativePath ? artifactPathKey(target.relativePath) : null,
            mediaType: target.mediaType,
            bytes: target.bytes,
            sha256: target.sha256,
            version: target.version,
            mutationRevision: (artifact.mutationRevision ?? 0) + 1,
            updatedAt: input.now,
          },
        },
        { upsert: false },
      );
      if ((updated.matchedCount ?? 0) !== 1) return { ok: false, reason: 'conflict' };
      const restored: ArtifactRecord = {
        ...artifact,
        mutationRevision: (artifact.mutationRevision ?? 0) + 1,
        kind: target.kind,
        filename: target.filename,
        mediaType: target.mediaType,
        bytes: target.bytes,
        sha256: target.sha256,
        version: target.version,
        updatedAt: input.now,
      };
      delete restored.relativePath;
      delete restored.pathKey;
      if (target.relativePath) {
        restored.relativePath = target.relativePath;
        restored.pathKey = artifactPathKey(target.relativePath);
      }
      return { ok: true, artifact: restored, version: target };
    },

    listExpired: async ({ now, limit, ownerId, mode }) => {
      const filter: Document = { cleanup: { $exists: false }, expiresAtMs: { $lte: Date.parse(now) } };
      if (ownerId) filter.ownerId = ownerId;
      if (mode) filter.mode = mode;
      const documents = await artifacts
        .find(filter)
        .sort({ expiresAtMs: 1 })
        .limit(limit)
        .toArray();
      return documents.map(toArtifact);
    },
  };
}

const HEALTH_KEY = '\u0000artifact-health';

export function createMongoBlobStore(input: {
  collections: Pick<MongoArtifactCollections, 'blobs' | 'chunks'>;
  clock: Clock;
  chunkBytes: number;
}): BlobStore {
  const { blobs, chunks } = input.collections;
  const chunkBytes = Math.max(65_536, Math.floor(input.chunkBytes));

  async function commitChunks(key: string, content: Uint8Array): Promise<number> {
    let index = 0;
    for (let offset = 0; offset < content.byteLength; offset += chunkBytes) {
      const slice = content.subarray(offset, Math.min(offset + chunkBytes, content.byteLength));
      try {
        await chunks.insertOne({ key, index, data: Buffer.from(slice).toString('base64') });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
      index += 1;
    }
    return index;
  }

  /**
   * Expired leases are removed one by one with a conditional update. Removing
   * the lease row and decrementing the count is one atomic document update, so
   * a crash between them is impossible. A lease whose process died is therefore
   * reclaimed as soon as it expires, never pinned forever.
   */
  async function pruneExpiredLeases(document: Document): Promise<void> {
    const nowMs = input.clock.now().getTime();
    const rows = Array.isArray(document.readLeases) ? document.readLeases : [];
    if (typeof document.key !== 'string' || rows.length === 0) return;
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const lease = row as Document;
      if (typeof lease.id !== 'string') continue;
      if (typeof lease.expiresAtMs !== 'number' || lease.expiresAtMs > nowMs) continue;
      await blobs.updateOne(
        { key: document.key, 'readLeases.id': lease.id },
        { $inc: { leaseCount: -1 }, $pull: { readLeases: { id: lease.id } } },
        { upsert: false },
      );
    }
  }

  return {
    durable: true,
    backend: 'mongodb',
    put: async ({ ownerId, mode, sha256, bytes, content }) => {
      verifyContent({ content, sha256, bytes });
      const key = blobKey({ ownerId, mode, sha256 });
      const existing = await blobs.findOne({ key });
      if (existing) {
        if (existing.bytes !== bytes || existing.sha256 !== sha256) {
          throw new BlobIntegrityError('A stored blob disagrees with its content address.');
        }
        return { created: false };
      }

      // Chunks are written before the descriptor. The descriptor is the commit
      // marker, so a crash mid-write leaves unreferenced chunks rather than a
      // descriptor that promises bytes which are not there.
      let chunkCount = 0;
      try {
        chunkCount = await commitChunks(key, content);
        const createdAt = input.clock.iso();
        await blobs.insertOne({
          key,
          ownerId,
          mode,
          sha256,
          bytes,
          chunks: chunkCount,
          trackedReferences: true,
          refCount: 0,
          leaseCount: 0,
          readLeases: [],
          referencedAtMs: Date.parse(createdAt),
          createdAt,
          createdAtMs: Date.parse(createdAt),
        });
        return { created: true };
      } catch (error) {
        if (isDuplicateKey(error)) return { created: false };
        await chunks.deleteMany({ key }).catch(() => undefined);
        throw error;
      }
    },

    get: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const meta = await blobs.findOne({ key });
      if (!meta) return null;
      const expected = typeof meta.chunks === 'number' ? meta.chunks : -1;
      const rows = await chunks.find({ key }).sort({ index: 1 }).toArray();
      if (expected < 0 || rows.length !== expected) {
        throw new BlobIntegrityError('A stored blob is missing one or more chunks.');
      }
      const parts: Buffer[] = [];
      for (const row of rows) {
        if (typeof row.data !== 'string') {
          throw new BlobIntegrityError('A stored blob chunk is malformed.');
        }
        parts.push(Buffer.from(row.data, 'base64'));
      }
      const content = Buffer.concat(parts);
      verifyContent({ content, sha256, bytes: typeof meta.bytes === 'number' ? meta.bytes : -1 });
      return content;
    },

    acquire: async ({ ownerId, mode, sha256, referenceId }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const acquired = await blobs.updateOne(
        { key },
        { ...(referenceId ? { $push: { referenceIds: referenceId } } : {}), $inc: { refCount: 1 }, $set: { referencedAtMs: input.clock.now().getTime() } },
        { upsert: false },
      );
      return (acquired.matchedCount ?? 0) === 1;
    },

    release: async ({ ownerId, mode, sha256, referenceId, legacyReleaseId }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const updated = await blobs.findOneAndUpdate(
        { key, refCount: { $gt: 0 }, ...(referenceId ? { referenceIds: referenceId } : {}),
          ...(legacyReleaseId ? { trackedReferences: { $exists: false }, legacyReleases: { $nin: [legacyReleaseId] } } : {}) },
        {
          ...(referenceId ? { $pull: { referenceIds: referenceId } } : {}),
          ...(legacyReleaseId ? { $push: { legacyReleases: legacyReleaseId } } : {}),
          $inc: { refCount: -1 },
          $set: { referencedAtMs: input.clock.now().getTime() },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated && typeof updated.refCount === 'number' ? updated.refCount : 0;
    },

    lease: async ({ ref: { ownerId, mode, sha256 }, ttlMs }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const leaseId = randomUUID();
      const expiresAtMs = input.clock.now().getTime() + Math.max(1, Math.floor(ttlMs));
      // The count and the lease row are one atomic update on the blob document.
      // A crash can therefore leave neither, never a count without a lease or a
      // lease without a count.
      const updated = await blobs.findOneAndUpdate(
        { key },
        {
          $inc: { leaseCount: 1 },
          $push: { readLeases: { id: leaseId, expiresAtMs } },
        },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated ? leaseId : null;
    },

    releaseLease: async ({ ref: { ownerId, mode, sha256 }, leaseId }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      await blobs.updateOne(
        { key, 'readLeases.id': leaseId },
        { $inc: { leaseCount: -1 }, $pull: { readLeases: { id: leaseId } } },
        { upsert: false },
      );
    },

    deleteIfUnreferenced: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const document = await blobs.findOne({ key });
      if (!document) return false;
      await pruneExpiredLeases(document);
      // The condition is in the delete itself. If an acquire or lease wins the
      // race the delete matches nothing; if the delete wins they find no
      // document. Neither ordering can lose a live reference or a live read.
      const removed = await blobs.deleteOne({
        key,
        refCount: { $lte: 0 },
        $or: [{ leaseCount: { $exists: false } }, { leaseCount: { $lte: 0 } }],
      });
      if ((removed.deletedCount ?? 0) !== 1) return false;
      await chunks.deleteMany({ key });
      return true;
    },

    delete: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      // Descriptor first: once it is gone the blob is unreachable, so a crash
      // can only leave inert chunks behind, never a read that promises bytes.
      const removed = await blobs.deleteOne({ key });
      await chunks.deleteMany({ key });
      return (removed.deletedCount ?? 0) === 1;
    },

    maintain: async ({ graceMs, limit }) => {
      const boundedLimit = Math.max(1, Math.floor(limit));
      const cutoff = Date.parse(input.clock.iso()) - Math.max(0, graceMs);
      // Reclaim expired read leases first, including on live blobs, so a crashed
      // download cannot make its blob permanently undeletable.
      const sampleForLeases = await blobs.find({}).limit(boundedLimit * 4).toArray();
      for (const document of sampleForLeases) await pruneExpiredLeases(document);

      const stale = await blobs
        .find({
          refCount: { $lte: 0 },
          createdAtMs: { $lt: cutoff },
          $or: [{ leaseCount: { $exists: false } }, { leaseCount: { $lte: 0 } }],
        })
        .limit(boundedLimit)
        .toArray();
      let unreferencedBlobs = 0;
      for (const document of stale) {
        if (typeof document.key !== 'string') continue;
        const removed = await blobs.deleteOne({
          key: document.key,
          refCount: { $lte: 0 },
          $or: [{ leaseCount: { $exists: false } }, { leaseCount: { $lte: 0 } }],
        });
        if ((removed.deletedCount ?? 0) === 1) {
          await chunks.deleteMany({ key: document.key });
          unreferencedBlobs += 1;
        }
      }

      // A sample of chunk rows is enough to reclaim the common failure: chunks
      // committed before their descriptor, or left by a delete that crashed.
      const sample = await chunks.find({}).limit(boundedLimit * 8).toArray();
      const keys = [
        ...new Set(
          sample
            .map((document) => document.key)
            .filter((key): key is string => typeof key === 'string'),
        ),
      ].slice(0, boundedLimit);
      let orphanChunks = 0;
      for (const key of keys) {
        if (await blobs.findOne({ key })) continue;
        const removed = await chunks.deleteMany({ key });
        orphanChunks += removed.deletedCount ?? 0;
      }
      return { orphanChunks, unreferencedBlobs };
    },

    reclaimLeaked: async ({ graceMs, limit, referenced }) => {
      const boundedLimit = Math.max(1, Math.floor(limit));
      const cutoff = input.clock.now().getTime() - Math.max(0, graceMs);
      const candidates = await blobs
        .find({
          refCount: { $gt: 0 },
          $or: [
            { referencedAtMs: { $lt: cutoff } },
            { referencedAtMs: { $exists: false }, createdAtMs: { $lt: cutoff } },
          ],
        })
        .limit(boundedLimit)
        .toArray();
      let removed = 0;
      for (const document of candidates) {
        if (
          typeof document.key !== 'string' ||
          typeof document.ownerId !== 'string' ||
          typeof document.mode !== 'string' ||
          typeof document.sha256 !== 'string' ||
          typeof document.refCount !== 'number'
        ) {
          continue;
        }
        const ref = {
          ownerId: document.ownerId,
          mode: document.mode as DataMode,
          sha256: document.sha256,
        };
        if (await referenced(ref)) continue;
        // The exact count makes a concurrent acquire win: it changes the count
        // between the read and this conditional delete, so nothing is removed.
        const deleted = await blobs.deleteOne({
          key: document.key,
          refCount: document.refCount,
        });
        if ((deleted.deletedCount ?? 0) === 1) {
          await chunks.deleteMany({ key: document.key });
          removed += 1;
        }
      }
      return removed;
    },

    check: async () => {
      await blobs.findOne({ key: HEALTH_KEY });
    },
  };
}
