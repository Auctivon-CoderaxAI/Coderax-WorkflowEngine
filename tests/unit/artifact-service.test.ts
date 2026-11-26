import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createArtifactService } from '../../src/artifacts/service.js';
import { createArtifactRepository } from '../../src/persistence/artifacts.js';
import { createInMemoryCapacityStore } from '../../src/persistence/capacity.js';
import type { BlobRef, BlobStore } from '../../src/persistence/blobs.js';
import { createConversationRepository } from '../../src/persistence/conversations.js';
import { createTaskRepository } from '../../src/persistence/tasks.js';
import type { AuditLog } from '../../src/observability/audit.js';
import type { Principal } from '../../src/security/auth.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';

/**
 * Durable artifact semantics without a database.
 *
 * The bytes here live in a reference-counted blob store that reports itself as
 * durable, so the service runs its real admission path: quota reservation,
 * content-addressed write, immutable version rows and reference release. What
 * this does not prove is MongoDB persistence; that needs a real server and is
 * covered by the durable integration test when one is configured. What it does
 * prove is that an upload is downloadable byte-for-byte, a new version does not
 * overwrite the old one, and deletion returns both the bytes and the quota.
 */

const principal: Principal = { ownerId: 'own_test', isOwner: true };

function durableBlobStore(): BlobStore {
  const entries = new Map<string, { content: Uint8Array; refs: number }>();
  const key = (ref: BlobRef): string => `${ref.ownerId}\u0000${ref.mode}\u0000${ref.sha256}`;
  return {
    durable: true,
    backend: 'test',
    put: async ({ ownerId, mode, sha256, content }) => {
      const id = key({ ownerId, mode, sha256 });
      if (entries.has(id)) return { created: false };
      entries.set(id, { content: Uint8Array.from(content), refs: 0 });
      return { created: true };
    },
    get: async (ref) => {
      const entry = entries.get(key(ref));
      return entry ? Uint8Array.from(entry.content) : null;
    },
    acquire: async (ref) => {
      const entry = entries.get(key(ref));
      if (!entry) return false;
      entry.refs += 1;
      return true;
    },
    release: async (ref) => {
      const entry = entries.get(key(ref));
      if (!entry) return 0;
      entry.refs = Math.max(0, entry.refs - 1);
      return entry.refs;
    },
    lease: async () => 'lease',
    releaseLease: async () => undefined,
    deleteIfUnreferenced: async (ref) => {
      const entry = entries.get(key(ref));
      if (!entry || entry.refs > 0) return false;
      entries.delete(key(ref));
      return true;
    },
    delete: async (ref) => entries.delete(key(ref)),
    maintain: async () => ({ orphanChunks: 0, unreferencedBlobs: 0 }),
    reclaimLeaked: async () => 0,
    check: async () => undefined,
  };
}

function encode(content: string): string {
  return Buffer.from(content, 'utf8').toString('base64');
}

test('an upload is downloadable, versioned and fully released on delete', async () => {
  const blobs = durableBlobStore();
  const service = createArtifactService({
    artifacts: createArtifactRepository(),
    blobs,
    capacity: createInMemoryCapacityStore(),
    ownerId: principal.ownerId,
    conversations: createConversationRepository(),
    tasks: createTaskRepository(),
    audit: { record: () => undefined } as unknown as AuditLog,
    clock: createClock(),
    ids: createIdGenerator(),
    settings: {
      maxBytesPerArtifact: 8_388_608,
      maxBytesPerOwner: 268_435_456,
      maxArtifactsPerOwner: 1_000,
      maxVersionsPerArtifact: 20,
      defaultRetentionDays: 0,
      maxRetentionDays: 365,
      chunkBytes: 1_048_576,
    },
  });

  const first = await service.upload(principal, {
    filename: 'notes.txt',
    mediaType: 'text/plain',
    contentBase64: encode('owner note'),
    mode: 'private',
  });
  assert.ok(first.ok, first.ok ? '' : first.detail);
  const artifactId = first.value.artifact.artifactId;
  assert.equal(first.value.artifact.version, 1);
  assert.equal(first.value.artifact.bytes, 10);
  assert.equal(
    first.value.artifact.sha256,
    createHash('sha256').update('owner note').digest('hex'),
  );

  const read = await service.download(principal, artifactId, { mode: 'private' });
  assert.ok(read.ok);
  assert.equal(Buffer.from(read.value.contentBase64, 'base64').toString('utf8'), 'owner note');

  const second = await service.addVersion(principal, artifactId, {
    filename: 'notes.txt',
    mediaType: 'text/plain',
    contentBase64: encode('owner note v2'),
    mode: 'private',
  });
  assert.ok(second.ok, second.ok ? '' : second.detail);
  assert.equal(second.value.artifact.version, 2);
  assert.equal(second.value.artifact.versions, 2);

  // An older version is immutable: version 1 still returns its own bytes.
  const original = await service.download(principal, artifactId, { mode: 'private', version: 1 });
  assert.ok(original.ok);
  assert.equal(Buffer.from(original.value.contentBase64, 'base64').toString('utf8'), 'owner note');

  const history = await service.versions(principal, artifactId, 'private');
  assert.ok(history.ok);
  assert.deepEqual(history.value.versions.map((row) => row.version), [1, 2]);

  const removed = await service.remove(principal, artifactId, 'private');
  assert.ok(removed.ok);
  assert.equal(removed.value.deletedVersions, 2);
  assert.equal(removed.value.releasedBytes, 23);

  const listed = await service.list(principal, { mode: 'private' });
  assert.ok(listed.ok);
  assert.equal(listed.value.artifacts.length, 0);
  assert.equal(listed.value.quota.artifacts, 0);
  assert.equal(listed.value.quota.usedBytes, 0);
});

test('a process-local deployment refuses the write instead of losing it', async () => {
  const service = createArtifactService({
    artifacts: createArtifactRepository(),
    blobs: { ...durableBlobStore(), durable: false, backend: 'memory' },
    capacity: createInMemoryCapacityStore(),
    ownerId: principal.ownerId,
    conversations: createConversationRepository(),
    tasks: createTaskRepository(),
    audit: { record: () => undefined } as unknown as AuditLog,
    clock: createClock(),
    ids: createIdGenerator(),
    settings: {
      maxBytesPerArtifact: 8_388_608,
      maxBytesPerOwner: 268_435_456,
      maxArtifactsPerOwner: 1_000,
      maxVersionsPerArtifact: 20,
      defaultRetentionDays: 0,
      maxRetentionDays: 365,
      chunkBytes: 1_048_576,
    },
  });

  const refused = await service.upload(principal, {
    filename: 'notes.txt',
    mediaType: 'text/plain',
    contentBase64: encode('owner note'),
    mode: 'private',
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? '' : refused.code, 'storage_unavailable');
});
