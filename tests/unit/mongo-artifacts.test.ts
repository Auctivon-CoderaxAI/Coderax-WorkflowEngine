import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMongoArtifactRepository,
  createMongoBlobStore,
  ensureArtifactIndexes,
} from '../../src/persistence/mongo-artifacts.js';
import { BlobIntegrityError, verifyContent } from '../../src/persistence/blobs.js';
import { digestOf } from '../../src/artifacts/media.js';
import { createFakeDatabase, type FakeCollection } from '../fakes/mongo.js';
import { cryptoRandomBytes } from '../fixtures/bytes.js';
import {
  artifactRecord,
  mutableClock,
  versionRecord,
} from '../fixtures/artifacts.js';
import { OWNER_ID } from '../helpers.js';

function setup() {
  const database = createFakeDatabase();
  // The fake exposes its documents; the production type deliberately does not,
  // so the cast is confined to this test's inspection helpers.
  const collections = {
    artifacts: database.collection('artifacts') as FakeCollection,
    versions: database.collection('artifact_versions') as FakeCollection,
    blobs: database.collection('artifact_blobs') as FakeCollection,
    chunks: database.collection('artifact_chunks') as FakeCollection,
  };
  return { database, collections };
}

test('artifact metadata supports versions, rollback, expiry and deletion', async () => {
  const { collections } = setup();
  await ensureArtifactIndexes(collections);
  const repository = createMongoArtifactRepository(collections);

  const created = await repository.create({
    artifact: artifactRecord(),
    version: versionRecord(),
  });
  assert.equal(created.ok, true);
  assert.equal(
    (await repository.create({ artifact: artifactRecord(), version: versionRecord() })).ok,
    false,
  );

  const stored = await repository.get({
    ownerId: OWNER_ID,
    mode: 'cloud',
    artifactId: 'art_test',
  });
  assert.equal(stored?.filename, 'report.pdf');

  const appended = await repository.appendVersion({
    artifact: artifactRecord({ version: 2, versions: 2, bytes: 64, sha256: 'b'.repeat(64), filename: 'report-v2.pdf' }),
    expectedVersion: 1,
    version: versionRecord({
      version: 2,
      bytes: 64,
      sha256: 'b'.repeat(64),
      filename: 'report-v2.pdf',
    }),
  });
  assert.equal(appended.ok, true);

  const stale = await repository.appendVersion({
    artifact: artifactRecord({ version: 3, versions: 3 }),
    expectedVersion: 1,
    version: versionRecord({ version: 3 }),
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.reason, 'conflict');

  assert.equal((await repository.versions({ ownerId: OWNER_ID, mode: 'cloud', artifactId: 'art_test' })).length, 2);
  assert.deepEqual(await repository.usage({ ownerId: OWNER_ID, mode: 'cloud' }), {
    bytes: 96,
    artifacts: 1,
  });
  assert.equal(
    await repository.referenced({ ownerId: OWNER_ID, mode: 'cloud', sha256: 'a'.repeat(64) }),
    true,
  );
  assert.equal(
    await repository.referenced({ ownerId: OWNER_ID, mode: 'private', sha256: 'a'.repeat(64) }),
    false,
  );

  const rolledBack = await repository.rollbackVersion({
    ownerId: OWNER_ID,
    mode: 'cloud',
    artifactId: 'art_test',
    version: 2,
  });
  assert.equal(rolledBack?.version, 2);
  const afterRollback = await repository.get({
    ownerId: OWNER_ID,
    mode: 'cloud',
    artifactId: 'art_test',
  });
  assert.equal(afterRollback?.version, 1);
  assert.equal(afterRollback?.filename, 'report.pdf');

  assert.equal(
    await repository.removeVersion({
      ownerId: OWNER_ID,
      mode: 'cloud',
      artifactId: 'art_test',
      version: 1,
    }),
    null,
  );

  const removed = await repository.remove({
    ownerId: OWNER_ID,
    mode: 'cloud',
    artifactId: 'art_test',
  });
  assert.equal(removed.versions.length, 1);
  assert.equal(removed.artifact?.artifactId, 'art_test');
  assert.equal(
    await repository.get({ ownerId: OWNER_ID, mode: 'cloud', artifactId: 'art_test' }),
    null,
  );
});

test('expired artifacts are found by their durable expiry field', async () => {
  const { collections } = setup();
  await ensureArtifactIndexes(collections);
  const repository = createMongoArtifactRepository(collections);

  await repository.create({
    artifact: artifactRecord({
      artifactId: 'art_expired',
      expiresAt: '2025-12-01T00:00:00.000Z',
    }),
    version: versionRecord({ artifactId: 'art_expired' }),
  });
  await repository.create({
    artifact: artifactRecord({ artifactId: 'art_live', expiresAt: null }),
    version: versionRecord({ artifactId: 'art_live' }),
  });

  const expired = await repository.listExpired({
    now: '2026-01-01T00:00:00.000Z',
    limit: 10,
  });
  assert.deepEqual(
    expired.map((record) => record.artifactId),
    ['art_expired'],
  );
  const scoped = await repository.listExpired({
    now: '2026-01-01T00:00:00.000Z',
    limit: 10,
    mode: 'private',
  });
  assert.equal(scoped.length, 0);
});

test('content is chunked, verified on read and removed with its descriptor', async () => {
  const { collections } = setup();
  await ensureArtifactIndexes(collections);
  const clock = mutableClock();
  const blobs = createMongoBlobStore({
    collections: { blobs: collections.blobs, chunks: collections.chunks },
    clock,
    chunkBytes: 65_536,
  });

  const content = cryptoRandomBytes(150_000);
  const sha256 = digestOf(content);
  assert.equal(blobs.durable, true);
  assert.deepEqual(await blobs.put({ ownerId: OWNER_ID, mode: 'cloud', sha256, bytes: content.length, content }), {
    created: true,
  });
  assert.equal(collections.chunks.documents.length, 3);

  const read = await blobs.get({ ownerId: OWNER_ID, mode: 'cloud', sha256 });
  assert.ok(read);
  assert.equal(Buffer.from(read).toString('hex'), content.toString('hex'));
  verifyContent({ content: read, sha256, bytes: content.length });

  // The other mode cannot read the same digest.
  assert.equal(await blobs.get({ ownerId: OWNER_ID, mode: 'private', sha256 }), null);

  // Tampering is detected, never silently returned.
  const chunk = collections.chunks.documents[1];
  assert.ok(chunk);
  chunk.data = Buffer.from('tampered').toString('base64');
  await assert.rejects(
    () => blobs.get({ ownerId: OWNER_ID, mode: 'cloud', sha256 }),
    (error: unknown) => error instanceof BlobIntegrityError,
  );

  assert.equal(await blobs.delete({ ownerId: OWNER_ID, mode: 'cloud', sha256 }), true);
  assert.equal(collections.blobs.documents.length, 0);
  assert.equal(collections.chunks.documents.length, 0);
});

test('identical content is stored once and is idempotent', async () => {
  const { collections } = setup();
  await ensureArtifactIndexes(collections);
  const blobs = createMongoBlobStore({
    collections: { blobs: collections.blobs, chunks: collections.chunks },
    clock: mutableClock(),
    chunkBytes: 65_536,
  });
  const content = Buffer.from('the same bytes');
  const sha256 = digestOf(content);

  assert.deepEqual(await blobs.put({ ownerId: OWNER_ID, mode: 'cloud', sha256, bytes: content.length, content }), {
    created: true,
  });
  assert.deepEqual(await blobs.put({ ownerId: OWNER_ID, mode: 'cloud', sha256, bytes: content.length, content }), {
    created: false,
  });
  assert.equal(collections.blobs.documents.length, 1);
});
