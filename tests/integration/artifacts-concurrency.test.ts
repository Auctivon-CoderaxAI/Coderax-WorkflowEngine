import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { ArtifactUploadResult } from '@coderax/contracts';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import type { MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { createMongoCapacityStore } from '../../src/persistence/capacity.js';
import { createMongoBlobStore } from '../../src/persistence/mongo-artifacts.js';
import { createClock } from '../../src/support/clock.js';
import { artifactSettings, base64, pngBytes } from '../fixtures/artifacts.js';
import {
  REAL_MONGO_SKIP,
  requireRealMongo,
  startRealMongo,
  type RealMongo,
} from '../fixtures/real-mongo.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_ID,
  OWNER_TOKEN,
  type TestWorkspace,
} from '../helpers.js';

/**
 * Real MongoDB, two engine processes and concurrent writers.
 *
 * The restart test proves bytes outlive one process. This file proves the
 * properties that only appear when two processes share the deployment: content
 * deduplication with counted references, quota admission that cannot over-admit,
 * abandoned reservations that return their capacity, corruption that is
 * reported rather than reconstructed, and a delete that cannot pull bytes out
 * from under an authorized reader.
 */

const maybeMongo = await startRealMongo();
requireRealMongo(maybeMongo);

const skip = maybeMongo === null ? REAL_MONGO_SKIP : false;

after(async () => {
  await maybeMongo?.stop();
});

type Replica = {
  app: Application;
  api: CoderaxClient;
};

function uniqueName(label: string): string {
  return `coderax_${label}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

async function boot(input: {
  real: RealMongo;
  databaseName: string;
  workspace: TestWorkspace;
  artifacts?: Record<string, unknown>;
}): Promise<Replica> {
  const database = await createMongoConnector()({
    uri: input.real.uri,
    database: input.databaseName,
  });
  const config = baseConfig(input.workspace, {
    persistence: { driver: 'mongo', database: input.databaseName },
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
  });
  const app = await composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    gateway: fakeGateway(),
    persistence: { database },
  });
  const { url } = await app.start();
  return { app, api: new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN }) };
}

async function observerFor(real: RealMongo, databaseName: string): Promise<MongoDatabase> {
  return createMongoConnector()({ uri: real.uri, database: databaseName });
}

test('two replicas read each other artifacts and deduplicate content per mode', { skip }, async () => {
  const real = maybeMongo as RealMongo;
  const databaseName = uniqueName('replicas');
  const workspaceA = createWorkspaces();
  const workspaceB = createWorkspaces();
  let a: Replica | undefined;
  let b: Replica | undefined;
  let observer: MongoDatabase | undefined;

  try {
    a = await boot({ real, databaseName, workspace: workspaceA });
    b = await boot({ real, databaseName, workspace: workspaceB });
    observer = await observerFor(real, databaseName);
    const content = pngBytes('replica-shared');

    const uploads = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        (index % 2 === 0 ? a as Replica : b as Replica).api.uploadArtifact({
          filename: `shared-${index}.png`,
          mediaType: 'image/png',
          contentBase64: base64(content),
          mode: 'cloud',
        }),
      ),
    );
    const ids = uploads.map((entry) => entry.artifact.artifactId);

    // Every replica can read every artifact, whichever replica wrote it.
    for (let index = 0; index < ids.length; index += 1) {
      const reader: Replica = index % 2 === 0 ? (b as Replica) : (a as Replica);
      const downloaded = await reader.api.downloadArtifact(ids[index] as string, {
        mode: 'cloud',
      });
      assert.equal(downloaded.contentBase64, base64(content));
      assert.equal(downloaded.artifact.filename, `shared-${index}.png`);
    }

    const blobs = await observer.collection('artifact_blobs').find({}).toArray();
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0]?.refCount, 6);

    // The same bytes in the other mode are a separate partition: deduplication
    // can never become an existence or content oracle across modes.
    const privateUpload = await (a as Replica).api.uploadArtifact({
      filename: 'private.png',
      mediaType: 'image/png',
      contentBase64: base64(content),
      mode: 'private',
    });
    const bothModes = await observer.collection('artifact_blobs').find({}).toArray();
    assert.equal(bothModes.length, 2);
    assert.equal(bothModes.filter((row) => row.mode === 'private').length, 1);
    await assert.rejects(
      () =>
        (b as Replica).api.downloadArtifact(privateUpload.artifact.artifactId, {
          mode: 'cloud',
        }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
    );
    await (a as Replica).api.deleteArtifact(privateUpload.artifact.artifactId, 'private');
    assert.equal(
      (await observer.collection('artifact_blobs').find({}).toArray()).length,
      1,
    );

    // One of six references released: the shared blob must survive.
    await (a as Replica).api.deleteArtifact(ids[0] as string, 'cloud');
    assert.equal(
      (await observer.collection('artifact_blobs').find({}).toArray()).length,
      1,
    );
    const stillThere = await (b as Replica).api.downloadArtifact(ids[1] as string, {
      mode: 'cloud',
    });
    assert.equal(stillThere.contentBase64, base64(content));

    await Promise.all(
      ids.slice(1).map((id, index) =>
        (index % 2 === 0 ? (a as Replica) : (b as Replica)).api.deleteArtifact(id, 'cloud'),
      ),
    );
    assert.equal(
      (await observer.collection('artifact_blobs').find({}).toArray()).length,
      0,
    );
    assert.equal(
      (await observer.collection('artifact_chunks').find({}).toArray()).length,
      0,
    );
    const capacity = await observer
      .collection('artifact_capacity')
      .findOne({ mode: 'cloud' });
    assert.equal(capacity?.availableBytes, artifactSettings().maxBytesPerOwner);
    assert.equal(capacity?.availableArtifacts, artifactSettings().maxArtifactsPerOwner);
  } finally {
    await a?.app.stop().catch(() => undefined);
    await b?.app.stop().catch(() => undefined);
    await observer?.close().catch(() => undefined);
    workspaceA.cleanup();
    workspaceB.cleanup();
  }
});

test('concurrent uploads across replicas cannot over-admit the byte quota', { skip }, async () => {
  const real = maybeMongo as RealMongo;
  const databaseName = uniqueName('quota');
  const workspaceA = createWorkspaces();
  const workspaceB = createWorkspaces();
  const size = 1_008;
  const maxBytes = size * 3;
  const limits = { maxBytesPerOwner: maxBytes, maxArtifactsPerOwner: 100 };
  let a: Replica | undefined;
  let b: Replica | undefined;
  let observer: MongoDatabase | undefined;

  try {
    a = await boot({ real, databaseName, workspace: workspaceA, artifacts: limits });
    b = await boot({ real, databaseName, workspace: workspaceB, artifacts: limits });
    observer = await observerFor(real, databaseName);

    const content = (index: number): Buffer => {
      const tag = Buffer.from(String(index).padStart(8, '0'));
      return Buffer.concat([pngBytes(''), tag, Buffer.alloc(1_000 - tag.length)]);
    };
    assert.equal(content(0).length, size);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? (a as Replica) : (b as Replica)).api.uploadArtifact({
          filename: `quota-${index}.png`,
          mediaType: 'image/png',
          contentBase64: base64(content(index)),
          mode: 'cloud',
        }),
      ),
    );
    const fulfilled = results.filter(
      (entry): entry is PromiseFulfilledResult<ArtifactUploadResult> =>
        entry.status === 'fulfilled',
    );
    const rejected = results.filter(
      (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
    );
    assert.equal(fulfilled.length, 3);
    assert.equal(rejected.length, 7);
    for (const failure of rejected) {
      assert.ok(
        failure.reason instanceof CoderaxApiError &&
          failure.reason.code === 'quota_exceeded',
      );
    }

    // Only admitted writes exist; a refused admission leaves no row, no blob
    // and no reservation behind.
    assert.equal(
      (await observer.collection('artifact_blobs').find({}).toArray()).length,
      3,
    );
    assert.equal(
      (await observer.collection('artifact_reservations').find({}).toArray()).length,
      0,
    );
    const capacity = await observer
      .collection('artifact_capacity')
      .findOne({ mode: 'cloud' });
    assert.equal(capacity?.availableBytes, 0);
    assert.equal(capacity?.availableArtifacts, 97);
    const versions = await observer
      .collection('artifact_versions')
      .find({ mode: 'cloud' })
      .toArray();
    assert.equal(
      versions.reduce((total, row) => total + (row.bytes as number), 0),
      maxBytes,
    );

    await Promise.all(
      fulfilled.map((entry, index) =>
        (index % 2 === 0 ? (a as Replica) : (b as Replica)).api.deleteArtifact(
          entry.value.artifact.artifactId,
          'cloud',
        ),
      ),
    );
    const restored = await observer
      .collection('artifact_capacity')
      .findOne({ mode: 'cloud' });
    assert.equal(restored?.availableBytes, maxBytes);
    assert.equal(restored?.availableArtifacts, 100);
    assert.equal(
      (await observer.collection('artifact_blobs').find({}).toArray()).length,
      0,
    );
  } finally {
    await a?.app.stop().catch(() => undefined);
    await b?.app.stop().catch(() => undefined);
    await observer?.close().catch(() => undefined);
    workspaceA.cleanup();
    workspaceB.cleanup();
  }
});

test('an abandoned admission returns its quota and a materialized one is committed', { skip }, async () => {
  const real = maybeMongo as RealMongo;
  const databaseName = uniqueName('reservations');
  const workspace = createWorkspaces();
  const limits = artifactSettings();
  let a: Replica | undefined;
  let observer: MongoDatabase | undefined;

  try {
    a = await boot({ real, databaseName, workspace });
    observer = await observerFor(real, databaseName);
    const capacity = createMongoCapacityStore({
      capacity: observer.collection('artifact_capacity'),
      reservations: observer.collection('artifact_reservations'),
    });
    const available = () => capacity.available({ ownerId: OWNER_ID, mode: 'cloud' });
    const before = await available();

    const abandoned = await capacity.reserve({
      ownerId: OWNER_ID,
      mode: 'cloud',
      bytes: 500,
      artifacts: 0,
      artifactId: 'art_never_written',
      version: 1,
      now: new Date().toISOString(),
      maxBytes: limits.maxBytesPerOwner,
      maxArtifacts: limits.maxArtifactsPerOwner,
      ttlMs: 1,
    });
    assert.equal(abandoned.ok, true);
    assert.equal((await available()).availableBytes, before.availableBytes - 500);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await (a as Replica).app.service.artifacts.sweepExpiredArtifacts();
    assert.equal((await available()).availableBytes, before.availableBytes);
    assert.equal(
      (await observer.collection('artifact_reservations').find({}).toArray()).length,
      0,
    );

    const uploaded = await (a as Replica).api.uploadArtifact({
      filename: 'kept.txt',
      mediaType: 'text/plain',
      contentBase64: base64(Buffer.from('kept')),
      mode: 'cloud',
    });
    const afterUpload = await available();

    // A reservation whose version row does exist is committed, not refunded:
    // the capacity it spent belongs to the durable artifact.
    const materialized = await capacity.reserve({
      ownerId: OWNER_ID,
      mode: 'cloud',
      bytes: 0,
      artifacts: 0,
      artifactId: uploaded.artifact.artifactId,
      version: uploaded.artifact.version,
      now: new Date().toISOString(),
      maxBytes: limits.maxBytesPerOwner,
      maxArtifacts: limits.maxArtifactsPerOwner,
      ttlMs: 1,
    });
    assert.equal(materialized.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await (a as Replica).app.service.artifacts.sweepExpiredArtifacts();
    assert.deepEqual(await available(), afterUpload);
    assert.equal(
      (await observer.collection('artifact_reservations').find({}).toArray()).length,
      0,
    );
  } finally {
    await a?.app.stop().catch(() => undefined);
    await observer?.close().catch(() => undefined);
    workspace.cleanup();
  }
});

test('a missing chunk is reported as corruption, never reconstructed', { skip }, async () => {
  const real = maybeMongo as RealMongo;
  const databaseName = uniqueName('integrity');
  const workspace = createWorkspaces();
  let a: Replica | undefined;
  let observer: MongoDatabase | undefined;

  try {
    a = await boot({ real, databaseName, workspace });
    observer = await observerFor(real, databaseName);
    const uploaded = await (a as Replica).api.uploadArtifact({
      filename: 'integrity.txt',
      mediaType: 'text/plain',
      contentBase64: base64(Buffer.from('integrity matters')),
      mode: 'cloud',
    });
    const chunks = await observer.collection('artifact_chunks').find({}).toArray();
    assert.ok(chunks.length >= 1);
    await observer.collection('artifact_chunks').deleteOne({ _id: chunks[0]?._id });

    await assert.rejects(
      () =>
        (a as Replica).api.downloadArtifact(uploaded.artifact.artifactId, {
          mode: 'cloud',
        }),
      (error: unknown) =>
        error instanceof CoderaxApiError &&
        error.status === 500 &&
        error.code === 'internal_error',
    );
    await assert.rejects(
      () =>
        (a as Replica).api.exportArtifact(uploaded.artifact.artifactId, {
          mode: 'cloud',
        }),
      (error: unknown) =>
        error instanceof CoderaxApiError &&
        error.status === 500 &&
        error.code === 'internal_error',
    );

    const deleted = await (a as Replica).api.deleteArtifact(
      uploaded.artifact.artifactId,
      'cloud',
    );
    assert.equal(deleted.deletedVersions, 1);
    assert.equal(
      (await observer.collection('artifact_chunks').find({}).toArray()).length,
      0,
    );
  } finally {
    await a?.app.stop().catch(() => undefined);
    await observer?.close().catch(() => undefined);
    workspace.cleanup();
  }
});

test('a delete during a read cannot remove the bytes under the reader', { skip }, async () => {
  const real = maybeMongo as RealMongo;
  const databaseName = uniqueName('inflight');
  const workspace = createWorkspaces();
  const content = Buffer.from('download in flight');
  let a: Replica | undefined;
  let observer: MongoDatabase | undefined;

  try {
    a = await boot({ real, databaseName, workspace });
    observer = await observerFor(real, databaseName);
    const uploaded = await (a as Replica).api.uploadArtifact({
      filename: 'inflight.txt',
      mediaType: 'text/plain',
      contentBase64: base64(content),
      mode: 'cloud',
    });
    const blobs = createMongoBlobStore({
      collections: {
        blobs: observer.collection('artifact_blobs'),
        chunks: observer.collection('artifact_chunks'),
      },
      clock: createClock(),
      chunkBytes: 1_048_576,
    });
    const ref = {
      ownerId: OWNER_ID,
      mode: 'cloud' as const,
      sha256: uploaded.artifact.sha256,
    };

    // Stand in for a download that has already taken its temporary reference.
    assert.equal(await blobs.acquire(ref), true);
    await (a as Replica).api.deleteArtifact(uploaded.artifact.artifactId, 'cloud');
    assert.equal(
      (await observer.collection('artifact_versions').find({}).toArray()).length,
      0,
    );

    const kept = await blobs.get(ref);
    assert.ok(kept);
    assert.equal(Buffer.from(kept).toString('utf8'), content.toString('utf8'));
    assert.equal(
      (await observer.collection('artifact_blobs').find({}).toArray()).length,
      1,
    );

    assert.equal(await blobs.release(ref), 0);
    assert.equal(await blobs.deleteIfUnreferenced(ref), true);
    assert.equal(await blobs.get(ref), null);
    assert.equal(
      (await observer.collection('artifact_chunks').find({}).toArray()).length,
      0,
    );
  } finally {
    await a?.app.stop().catch(() => undefined);
    await observer?.close().catch(() => undefined);
    workspace.cleanup();
  }
});
