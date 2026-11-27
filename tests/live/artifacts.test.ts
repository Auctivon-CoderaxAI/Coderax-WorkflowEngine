import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoClient } from 'mongodb';
import { createMongoConnector } from '../../src/persistence/mongo-connect.js';
import {
  createMongoArtifactRepository,
  ensureArtifactIndexes,
} from '../../src/persistence/mongo-artifacts.js';
import { artifactRecord, versionRecord } from '../fixtures/artifacts.js';

/**
 * Real MongoDB only.
 *
 * An artifact's identity is enforced by a unique database index, so two
 * replicas racing the same owner/mode/artifactId cannot both create it. A fake
 * collection cannot prove that; this suite opens two independent connections to
 * a real server and races the insert.
 */

const uri = process.env.CODERAX_TEST_MONGO_URI ?? process.env.CODERAX_TEST_MONGODB_URI;
const required =
  process.env.CODERAX_REQUIRE_MONGO === '1' || process.env.CODERAX_REQUIRE_MONGODB === '1';
const databaseName = `coderax_ci_artifacts_${process.pid}_${Date.now()}`;

function collectionsOf(database: { collection: (name: string) => never }) {
  return {
    artifacts: database.collection('artifacts'),
    versions: database.collection('artifact_versions'),
    blobs: database.collection('artifact_blobs'),
    chunks: database.collection('artifact_chunks'),
  };
}

test(
  'two real connections cannot create one artifact identity twice',
  { skip: uri ? false : required ? false : 'No real MongoDB: set CODERAX_TEST_MONGO_URI or CODERAX_TEST_MONGODB_URI' },
  async () => {
    assert.ok(uri, 'a real MongoDB URI is required when the lane is required');
    const connector = createMongoConnector();
    const first = await connector({ uri, database: databaseName });
    try {
      const firstCollections = collectionsOf(first as never);
      await ensureArtifactIndexes(firstCollections);

      const second = await connector({ uri, database: databaseName });
      try {
        const left = createMongoArtifactRepository(firstCollections);
        const right = createMongoArtifactRepository(collectionsOf(second as never));

        const artifact = artifactRecord();
        const version = versionRecord();
        const [a, b] = await Promise.all([
          left.create({ artifact, version }),
          right.create({ artifact, version }),
        ]);
        assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
      const client = new MongoClient(uri);
      try {
        await client.connect();
        await client.db(databaseName).dropDatabase();
      } finally {
        await client.close();
      }
    }
  },
);
