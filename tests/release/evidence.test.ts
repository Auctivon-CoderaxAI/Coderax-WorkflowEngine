import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ensureWorkRunIndexes } from '../../src/persistence/mongo.js';
import { ensureEventIndexes } from '../../src/persistence/mongo-events.js';
import {
  ensureArtifactIndexes,
  ensurePermissionIndexes,
  ensureScheduleIndexes,
} from '../../src/persistence/mongo-records.js';
import {
  ensureConversationIndexes,
  ensureIdempotencyIndexes,
  ensureMemoryIndexes,
  ensureNotificationIndexes,
  ensureTaskIndexes,
} from '../../src/persistence/mongo-tables.js';
import { createFakeCollection, type FakeCollection } from '../fakes/mongo.js';
import { DATABASE_MIGRATIONS } from '../../scripts/release/migrations.js';
import { parseReleaseManifest } from '../../scripts/release/manifest.js';

function committedManifest() {
  return parseReleaseManifest(
    readFileSync(path.join(process.cwd(), 'release', 'train.json'), 'utf8'),
  );
}

test('the declared migrations are exactly the indexes the engine creates', async () => {
  const actual: Array<{
    collection: string;
    keys: Record<string, 1 | -1>;
    unique: boolean;
    name: string;
  }> = [];
  function record(collectionName: string, collection: FakeCollection): void {
    for (const index of collection.indexes) {
      assert.ok(index.options?.name, `an index on ${collectionName} has no name`);
      actual.push({
        collection: collectionName,
        keys: index.keys,
        unique: index.options?.unique ?? false,
        name: index.options.name,
      });
    }
  }

  const workRuns = createFakeCollection();
  await ensureWorkRunIndexes(workRuns);
  record('work_runs', workRuns);

  const tasks = createFakeCollection();
  await ensureTaskIndexes(tasks);
  record('tasks', tasks);

  const idempotency = createFakeCollection();
  await ensureIdempotencyIndexes(idempotency);
  record('idempotency', idempotency);

  const conversations = createFakeCollection();
  const messages = createFakeCollection();
  await ensureConversationIndexes({ conversations, messages });
  record('conversations', conversations);
  record('messages', messages);

  const memory = createFakeCollection();
  await ensureMemoryIndexes(memory);
  record('memory', memory);

  const notifications = createFakeCollection();
  await ensureNotificationIndexes(notifications);
  record('notifications', notifications);

  const permissions = createFakeCollection();
  await ensurePermissionIndexes(permissions);
  record('permissions', permissions);

  const schedules = createFakeCollection();
  await ensureScheduleIndexes(schedules);
  record('schedules', schedules);

  const artifacts = createFakeCollection();
  await ensureArtifactIndexes(artifacts);
  record('artifacts', artifacts);

  const events = createFakeCollection();
  const heads = createFakeCollection();
  await ensureEventIndexes({ events, heads });
  record('events', events);
  record('event_heads', heads);

  const declared = DATABASE_MIGRATIONS.map((migration) => ({
    collection: migration.collection,
    keys: migration.keys,
    unique: migration.unique,
    name: migration.name,
  }));
  assert.deepEqual(
    actual,
    declared,
    'every index the engine creates must be declared, and no declared index may be uncreated',
  );
});

test('the committed matrix publishes the same migrations as the engine', () => {
  assert.deepEqual(committedManifest().engine.migrations, DATABASE_MIGRATIONS);
});

test('the committed SDK artifact matches its SHA-256, SHA-512 and file list', () => {
  const manifest = committedManifest();
  const artifactPath = path.join(process.cwd(), manifest.engine.sdkArtifact.path);
  const bytes = readFileSync(artifactPath);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.engine.sdkArtifact.sha256);
  assert.equal(createHash('sha512').update(bytes).digest('hex'), manifest.engine.sdkArtifact.sha512);
  assert.equal(
    `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    manifest.engine.sdkArtifact.integrity,
  );

  const files = execFileSync('tar', ['-tzf', artifactPath], { encoding: 'utf8' })
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(files, [...manifest.engine.sdkArtifact.files].sort());
  assert.ok(files.includes('package/dist/index.js'));
  assert.ok(files.includes('package/dist/index.d.ts'));
});

test('the committed engine verification log matches its recorded checksum', () => {
  const manifest = committedManifest();
  const log = readFileSync(path.join(process.cwd(), manifest.engine.localVerification.path), 'utf8');
  assert.equal(
    createHash('sha256').update(log, 'utf8').digest('hex'),
    manifest.engine.localVerification.outputSha256,
  );
  assert.match(log, new RegExp(`pass ${manifest.engine.localVerification.tests}`));
  assert.match(log, /fail 0/);
  assert.match(log, /openapi\.json matches the published contracts/);
});
