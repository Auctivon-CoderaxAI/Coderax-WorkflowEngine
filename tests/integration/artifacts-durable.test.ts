import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import type { MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { base64, pngBytes } from '../fixtures/artifacts.js';
import {
  requireRealMongo,
  startRealMongo,
  type RealMongo,
} from '../fixtures/real-mongo.js';
import {
  baseConfig,
  createWorkspaces,
  fakeGateway,
  OWNER_TOKEN,
  type TestWorkspace,
} from '../helpers.js';

/**
 * Real durable storage, not a fake.
 *
 * The test needs an actual MongoDB server and the real `mongodb` driver. It
 * prefers `CODERAX_TEST_MONGODB_URI`; otherwise it starts a real mongod through
 * `mongodb-memory-server` when that test-only package is installed. If neither
 * is available the test is skipped with the reason, never reported as passing.
 *
 * What it proves: bytes and metadata written by one engine process are read by
 * a second process that opened its own connection, with the same digest and
 * version history, and that deletion releases the stored chunks.
 */

const maybeMongo = await startRealMongo();
requireRealMongo(maybeMongo);

async function startEngine(input: {
  database: MongoDatabase;
  workspace: TestWorkspace;
  databaseName: string;
}): Promise<Application> {
  const config = baseConfig(input.workspace, {
    persistence: { driver: 'mongo', database: input.databaseName },
  });
  return composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    gateway: fakeGateway(),
    persistence: { database: input.database },
  });
}

test(
  'artifact bytes and metadata survive a real MongoDB engine restart',
  {
    skip:
      maybeMongo === null
        ? 'No real MongoDB: set CODERAX_TEST_MONGODB_URI or install mongodb-memory-server.'
        : false,
  },
  async () => {
    const real = maybeMongo as RealMongo;
    const databaseName = `coderax_artifacts_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
    const connect = createMongoConnector();
    const firstWorkspace = createWorkspaces();
    const secondWorkspace = createWorkspaces();
    const started: Application[] = [];
    const connections: MongoDatabase[] = [];
    const original = pngBytes('durable-restart');

    try {
      const firstDatabase = await connect({ uri: real.uri, database: databaseName });
      connections.push(firstDatabase);
      const first = await startEngine({
        database: firstDatabase,
        workspace: firstWorkspace,
        databaseName,
      });
      started.push(first);
      const { url } = await first.start();
      const api = new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
      const uploaded = await api.uploadArtifact({
        filename: 'durable-chart.png',
        mediaType: 'image/png',
        contentBase64: base64(original),
        mode: 'cloud',
        projectId: 'proj_durable',
      });
      const artifactId = uploaded.artifact.artifactId;
      await api.uploadArtifactVersion(artifactId, {
        filename: 'durable-chart-v2.png',
        mediaType: 'image/png',
        contentBase64: base64(pngBytes('durable-v2')),
        mode: 'cloud',
      });

      // Closing the first engine closes its database connection: the next read
      // cannot come from anything this process kept in memory.
      await first.stop();

      const secondDatabase = await connect({ uri: real.uri, database: databaseName });
      connections.push(secondDatabase);
      const second = await startEngine({
        database: secondDatabase,
        workspace: secondWorkspace,
        databaseName,
      });
      started.push(second);
      const secondUrl = (await second.start()).url;
      const secondApi = new CoderaxClient({ baseUrl: secondUrl, token: OWNER_TOKEN });

      const descriptor = await secondApi.artifact(artifactId, 'cloud');
      assert.equal(descriptor.version, 2);
      assert.equal(descriptor.projectId, 'proj_durable');

      const downloaded = await secondApi.downloadArtifact(artifactId, {
        mode: 'cloud',
        version: 1,
      });
      assert.equal(downloaded.contentBase64, base64(original));

      const versions = await secondApi.artifactVersions(artifactId, 'cloud');
      assert.deepEqual(
        versions.versions.map((entry) => entry.version),
        [1, 2],
      );

      await assert.rejects(
        () => secondApi.downloadArtifact(artifactId, { mode: 'private' }),
        (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
      );

      // The bytes are genuinely in MongoDB: the raw collections hold the
      // descriptors, version rows and chunks this engine just read.
      const blobRows = await secondDatabase.collection('artifact_blobs').find({}).toArray();
      assert.equal(blobRows.length, 2);
      const versionRows = await secondDatabase
        .collection('artifact_versions')
        .find({})
        .toArray();
      assert.equal(versionRows.length, 2);
      const chunkRows = await secondDatabase.collection('artifact_chunks').find({}).toArray();
      assert.ok(chunkRows.length >= 2);

      const deleted = await secondApi.deleteArtifact(artifactId, 'cloud');
      assert.equal(deleted.deletedVersions, 2);
      assert.equal(
        (await secondDatabase.collection('artifact_blobs').find({}).toArray()).length,
        0,
      );
      assert.equal(
        (await secondDatabase.collection('artifact_chunks').find({}).toArray()).length,
        0,
      );
      assert.equal(
        (await secondDatabase.collection('artifact_versions').find({}).toArray()).length,
        0,
      );
    } finally {
      for (const app of started) await app.stop().catch(() => undefined);
      for (const connection of connections) await connection.close().catch(() => undefined);
      firstWorkspace.cleanup();
      secondWorkspace.cleanup();
      await real.stop();
    }
  },
);
