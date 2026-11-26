import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import type { MongoDatabase } from '../../src/persistence/mongo-connect.js';
import {
  REAL_MONGO_SKIP,
  configuredMongo,
  requireRealMongo,
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
 * prefers `CODERAX_TEST_MONGODB_URI`; without one it is skipped with the reason,
 * never reported as passing, and the CI lane sets `CODERAX_REQUIRE_MONGODB=1`
 * so a missing service fails the check.
 *
 * What it proves: bytes and metadata written by one engine process are read by
 * a second process that opened its own connection, with the same digest and
 * version history, and that deletion releases the stored chunks.
 */

const maybeMongo = configuredMongo();
requireRealMongo(maybeMongo);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** The validator decides on the signature, so a PNG signature is enough. */
function pngBytes(extra = 'IHDR'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(extra, 'latin1'),
  ]);
}

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
    skip: maybeMongo === null ? REAL_MONGO_SKIP : false,
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
    let secondDatabase: MongoDatabase | undefined;

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
      assert.equal(
        uploaded.artifact.sha256,
        createHash('sha256').update(original).digest('hex'),
      );
      await api.uploadArtifactVersion(artifactId, {
        filename: 'durable-chart-v2.png',
        mediaType: 'image/png',
        contentBase64: base64(pngBytes('durable-v2')),
        mode: 'cloud',
      });

      // Closing the first engine closes its database connection: the next read
      // cannot come from anything this process kept in memory.
      await first.stop();

      secondDatabase = await connect({ uri: real.uri, database: databaseName });
      connections.push(secondDatabase);
      const second = await startEngine({
        database: secondDatabase,
        workspace: secondWorkspace,
        databaseName,
      });
      started.push(second);
      const secondUrl = (await second.start()).url;
      const secondApi = new CoderaxClient({ baseUrl: secondUrl, token: OWNER_TOKEN });

      const descriptor = await secondApi.getArtifact(artifactId, 'cloud');
      assert.equal(descriptor.version, 2);
      assert.equal(descriptor.projectId, 'proj_durable');

      const downloaded = await secondApi.downloadArtifact(artifactId, {
        mode: 'cloud',
        version: 1,
      });
      assert.equal(downloaded.contentBase64, base64(original));

      const versions = await secondApi.listArtifactVersions(artifactId, 'cloud');
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
      for (const collection of ['artifact_blobs', 'artifact_chunks', 'artifact_versions']) {
        assert.equal(
          (await secondDatabase.collection(collection).find({}).toArray()).length,
          0,
          `${collection} still holds rows after the artifact was deleted`,
        );
      }
    } finally {
      for (const app of started) await app.stop().catch(() => undefined);
      for (const connection of connections) await connection.close().catch(() => undefined);
      firstWorkspace.cleanup();
      secondWorkspace.cleanup();
      // The service container is discarded after the run; a local server is not,
      // so remove the throwaway database this test created.
      const cleanup = new MongoClient(real.uri);
      await cleanup
        .connect()
        .then(() => cleanup.db(databaseName).dropDatabase())
        .catch(() => undefined)
        .finally(() => cleanup.close().catch(() => undefined));
    }
  },
);
