import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { composeApplication, type Application } from '../../src/bootstrap/compose.js';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import type { MongoDatabase } from '../../src/persistence/mongo-connect.js';
import { requireRealMongo, startRealMongo, type RealMongo } from '../fixtures/real-mongo.js';
import {
  baseConfig,
  createWorkspaces,
  fakeProvider,
  OWNER_TOKEN,
  pngBytes,
} from '../helpers.js';

/**
 * Media is a view over the artifact authority, proven on a real server.
 *
 * `POST /v1/media` performs media-specific validation and then writes an
 * immutable artifact version; it owns no collection, no blob store and no
 * quota. These tests exercise the public API against a real MongoDB and assert
 * the consequences: the media id is an artifact id, a version added through
 * `/v1/artifacts` is what `/v1/media` returns, deletion through the artifact
 * API removes the media, a non-image artifact is not exposed as media, and a
 * media upload is admitted from the same quota the artifact API enforces.
 *
 * The suite runs in the `mongodb` CI job with `CODERAX_REQUIRE_MONGODB=1`, so it
 * fails rather than skips when no real server is reachable.
 */

const maybeMongo = await startRealMongo();
requireRealMongo(maybeMongo);

async function startEngine(input: {
  database: MongoDatabase;
  workspace: ReturnType<typeof createWorkspaces>;
  databaseName: string;
  artifacts?: Record<string, unknown>;
}): Promise<Application> {
  const config = baseConfig(input.workspace, {
    persistence: { driver: 'mongo', database: input.databaseName },
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
  });
  return composeApplication({
    config,
    env: { CODERAX_OWNER_TOKEN: OWNER_TOKEN },
    providers: [{ adapter: fakeProvider() }],
    persistence: { database: input.database },
  });
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function databaseName(prefix: string): string {
  return `coderax_${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

test(
  'media is a versioned view over the durable artifact authority',
  {
    skip:
      maybeMongo === null
        ? 'No real MongoDB: set CODERAX_TEST_MONGODB_URI or install mongodb-memory-server.'
        : false,
  },
  async () => {
    const real = maybeMongo as RealMongo;
    const name = databaseName('media_authority');
    const connect = createMongoConnector();
    const workspace = createWorkspaces();
    const database = await connect({ uri: real.uri, database: name });
    const connections: MongoDatabase[] = [database];
    const started: Application[] = [];

    try {
      const app = await startEngine({ database, workspace, databaseName: name });
      started.push(app);
      const api = new CoderaxClient({ baseUrl: (await app.start()).url, token: OWNER_TOKEN });

      const first = pngBytes(12, 8);
      const uploaded = await api.uploadMedia({
        mode: 'cloud',
        data: first.toString('base64'),
        declaredType: 'image/png',
      });
      const mediaId = uploaded.media.mediaId;

      // The media id is an artifact id, and the artifact descriptor is the
      // authoritative record for the same bytes.
      const artifact = await api.artifact(mediaId, 'cloud');
      assert.equal(artifact.artifactId, mediaId);
      assert.equal(artifact.kind, 'image');
      assert.equal(artifact.mediaType, 'image/png');
      assert.equal(artifact.filename, 'media.png');
      assert.equal(artifact.mode, 'cloud');
      assert.equal(artifact.version, 1);
      assert.equal(artifact.versions, 1);
      assert.equal(artifact.bytes, first.length);
      assert.equal(artifact.sha256, uploaded.media.sha256);
      assert.equal(artifact.sha256, digest(first));
      assert.equal(artifact.inferenceExposure, 'none');

      const versions = await api.artifactVersions(mediaId, 'cloud');
      assert.deepEqual(
        versions.versions.map((entry) => entry.version),
        [1],
      );
      assert.equal(versions.versions[0]?.sha256, digest(first));

      const content = await api.downloadArtifact(mediaId, { mode: 'cloud' });
      assert.equal(content.contentBase64, first.toString('base64'));

      // A version written through the artifact API is what media serves: the
      // media layer reads the authority instead of keeping a copy.
      const second = pngBytes(7, 3);
      const added = await api.uploadArtifactVersion(mediaId, {
        filename: 'media-v2.png',
        mediaType: 'image/png',
        contentBase64: second.toString('base64'),
        mode: 'cloud',
      });
      assert.equal(added.artifact.version, 2);
      assert.equal(added.artifact.versions, 2);

      const reread = await api.media(mediaId);
      assert.equal(reread.media.mediaId, mediaId);
      assert.equal(reread.media.bytes, second.length);
      assert.equal(reread.media.sha256, digest(second));
      assert.equal(reread.media.width, 7);
      assert.equal(reread.media.height, 3);
      assert.equal(reread.data, second.toString('base64'));

      const versionRows = await database
        .collection('artifact_versions')
        .find({})
        .toArray();
      assert.deepEqual(
        versionRows
          .filter((row) => row.artifactId === mediaId)
          .map((row) => row.version)
          .sort(),
        [1, 2],
      );
      assert.ok((await database.collection('artifact_blobs').find({}).toArray()).length >= 2);

      // Mode scoping comes from the artifact authority: the cloud artifact is
      // absent from the private partition.
      await assert.rejects(
        () => api.artifact(mediaId, 'private'),
        (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
      );

      // Media validation still decides what may be served as an image: a
      // stored non-image artifact is not exposed through /v1/media.
      const note = await api.uploadArtifact({
        filename: 'note.txt',
        mediaType: 'text/plain',
        kind: 'document',
        mode: 'cloud',
        contentBase64: Buffer.from('plain note', 'utf8').toString('base64'),
      });
      await assert.rejects(
        () => api.media(note.artifact.artifactId),
        (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
      );

      // Deleting through the artifact API removes the media and its bytes.
      const deleted = await api.deleteArtifact(mediaId, 'cloud');
      assert.equal(deleted.deletedVersions, 2);
      await assert.rejects(
        () => api.media(mediaId),
        (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
      );
      await assert.rejects(
        () => api.artifactVersions(mediaId, 'cloud'),
        (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
      );
      assert.equal(
        (await database.collection('artifact_versions').find({}).toArray()).filter(
          (row) => row.artifactId === mediaId,
        ).length,
        0,
      );
      assert.equal(
        (await database.collection('artifact_blobs').find({}).toArray()).filter(
          (row) => row.digest === digest(second),
        ).length,
        0,
      );

      // A second engine instance reads the media from the same server, so the
      // media list is durable rather than process memory.
      const survivor = pngBytes(5, 5);
      const kept = await api.uploadMedia({
        mode: 'cloud',
        data: survivor.toString('base64'),
      });
      await app.stop();
      started.pop();

      // A stopped engine closes its connection, so the restart opens its own.
      const secondDatabase = await connect({ uri: real.uri, database: name });
      connections.push(secondDatabase);
      const restarted = await startEngine({
        database: secondDatabase,
        workspace,
        databaseName: name,
      });
      started.push(restarted);
      const secondApi = new CoderaxClient({
        baseUrl: (await restarted.start()).url,
        token: OWNER_TOKEN,
      });
      const durable = await secondApi.media(kept.media.mediaId);
      assert.equal(durable.data, survivor.toString('base64'));
      assert.equal((await secondApi.artifact(kept.media.mediaId, 'cloud')).sha256, digest(survivor));
    } finally {
      for (const app of started) await app.stop().catch(() => undefined);
      for (const connection of connections) await connection.close().catch(() => undefined);
      workspace.cleanup();
      await real.stop();
    }
  },
);

test(
  'media admissions draw on the artifact quota ledger',
  {
    skip:
      maybeMongo === null
        ? 'No real MongoDB: set CODERAX_TEST_MONGODB_URI or install mongodb-memory-server.'
        : false,
  },
  async () => {
    const real = maybeMongo as RealMongo;
    const name = databaseName('media_quota');
    const workspace = createWorkspaces();
    const database = await createMongoConnector()({ uri: real.uri, database: name });
    const started: Application[] = [];

    try {
      const app = await startEngine({
        database,
        workspace,
        databaseName: name,
        artifacts: { maxArtifactsPerOwner: 1 },
      });
      started.push(app);
      const api = new CoderaxClient({ baseUrl: (await app.start()).url, token: OWNER_TOKEN });

      // One artifact fills the single slot. A media upload is the next
      // admission, and it is refused by the same ledger: media has no quota of
      // its own and cannot spend past the artifact limit.
      await api.uploadArtifact({
        filename: 'note.txt',
        mediaType: 'text/plain',
        kind: 'document',
        mode: 'cloud',
        contentBase64: Buffer.from('one note', 'utf8').toString('base64'),
      });

      await assert.rejects(
        () =>
          api.uploadMedia({
            mode: 'cloud',
            data: pngBytes().toString('base64'),
          }),
        (error: unknown) => {
          assert.ok(error instanceof CoderaxApiError);
          assert.equal(error.code, 'quota_exceeded');
          return true;
        },
      );
    } finally {
      for (const app of started) await app.stop().catch(() => undefined);
      workspace.cleanup();
      await database.close().catch(() => undefined);
      await real.stop();
    }
  },
);
