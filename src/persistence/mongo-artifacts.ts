import type { ArtifactRecord, ArtifactVersionRecord } from '../domain.js';
import type {
  AppendVersionOutcome,
  ArtifactKey,
  ArtifactListFilter,
  ArtifactRepository,
  ArtifactUsage,
  CreateArtifactOutcome,
  RemoveArtifactOutcome,
} from './artifacts.js';
import { blobKey, BlobIntegrityError, verifyContent, type BlobStore } from './blobs.js';
import { isDuplicateKey, type MongoCollectionLike } from './mongo.js';
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

  function matches(record: ArtifactRecord, filter: ArtifactListFilter): boolean {
    if (record.mode !== filter.mode) return false;
    if (filter.kind && record.kind !== filter.kind) return false;
    if (filter.projectId && record.projectId !== filter.projectId) return false;
    if (filter.conversationId && record.conversationId !== filter.conversationId) return false;
    if (filter.taskId && record.taskId !== filter.taskId) return false;
    return true;
  }

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
      if (current.version !== expectedVersion) return { ok: false, reason: 'conflict' };

      // The version number is part of the filter: two replicas that both read
      // version N cannot both write N+1.
      const updated = await artifacts.updateOne(
        { ...key, version: expectedVersion },
        { $set: artifactDocument(artifact) },
        { upsert: false },
      );
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
      const stored = await artifacts.findOne(identity(key));
      return stored ? toArtifact(stored) : null;
    },

    list: async (ownerId, filter) => {
      const documents = await artifacts
        .find({ ownerId, mode: filter.mode })
        .sort({ updatedAt: -1 })
        .toArray();
      return documents
        .map(toArtifact)
        .filter((record) => matches(record, filter))
        .slice(0, filter.limit);
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
      const rows = await versions.find({ ownerId, mode }).toArray();
      const bytes = rows.reduce((total, row) => total + (toVersion(row).bytes ?? 0), 0);
      const artifacts = await collections.artifacts.find({ ownerId, mode }).toArray();
      return { bytes, artifacts: artifacts.length };
    },

    referenced: async ({ ownerId, mode, sha256 }) =>
      (await versions.findOne({ ownerId, mode, sha256 })) !== null,

    remove: async (key): Promise<RemoveArtifactOutcome> => {
      const stored = await artifacts.findOne(identity(key));
      const rows = await versions.find(identity(key)).sort({ version: 1 }).toArray();
      await versions.deleteMany(identity(key));
      await artifacts.deleteOne(identity(key));
      return {
        artifact: stored ? toArtifact(stored) : null,
        versions: rows.map(toVersion),
      };
    },

    removeVersion: async (input) => {
      const key = identity(input);
      const stored = await artifacts.findOne(key);
      if (!stored) return null;
      const artifact = toArtifact(stored);
      if (input.version >= artifact.version) return null;
      const row = await versions.findOne({ ...key, version: input.version });
      if (!row) return null;
      await versions.deleteOne({ ...key, version: input.version });
      await artifacts.updateOne(
        { ...key, version: artifact.version },
        { $set: { versions: Math.max(1, artifact.versions - 1) } },
        { upsert: false },
      );
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

    listExpired: async ({ now, limit, ownerId, mode }) => {
      const filter: Document = { expiresAtMs: { $lte: Date.parse(now) } };
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
          refCount: 0,
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

    acquire: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const acquired = await blobs.updateOne(
        { key },
        { $inc: { refCount: 1 } },
        { upsert: false },
      );
      return (acquired.matchedCount ?? 0) === 1;
    },

    release: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      const updated = await blobs.findOneAndUpdate(
        { key, refCount: { $gt: 0 } },
        { $inc: { refCount: -1 } },
        { returnDocument: 'after', includeResultMetadata: false },
      );
      return updated && typeof updated.refCount === 'number' ? updated.refCount : 0;
    },

    deleteIfUnreferenced: async ({ ownerId, mode, sha256 }) => {
      const key = blobKey({ ownerId, mode, sha256 });
      // The condition is in the delete itself. If an acquire wins the race the
      // delete matches nothing; if the delete wins the acquire finds no document
      // and the writer re-puts the bytes. Neither ordering can lose a reference.
      const removed = await blobs.deleteOne({ key, refCount: { $lte: 0 } });
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
      const stale = await blobs
        .find({ refCount: { $lte: 0 }, createdAtMs: { $lt: cutoff } })
        .limit(boundedLimit)
        .toArray();
      let unreferencedBlobs = 0;
      for (const document of stale) {
        if (typeof document.key !== 'string') continue;
        const removed = await blobs.deleteOne({
          key: document.key,
          refCount: { $lte: 0 },
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

    check: async () => {
      await blobs.findOne({ key: HEALTH_KEY });
    },
  };
}
