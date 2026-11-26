import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ensureWorkRunIndexes } from '../../src/persistence/mongo.js';
import { createFakeCollection } from '../fakes/mongo.js';
import { DATABASE_MIGRATIONS } from '../../scripts/release/migrations.js';
import { parseReleaseManifest } from '../../scripts/release/manifest.js';

function committedManifest() {
  return parseReleaseManifest(
    readFileSync(path.join(process.cwd(), 'release', 'train.json'), 'utf8'),
  );
}

test('the declared migrations are exactly the indexes the engine creates', async () => {
  const collection = createFakeCollection();
  await ensureWorkRunIndexes(collection);
  assert.equal(collection.indexes.length, DATABASE_MIGRATIONS.length);
  for (const [index, migration] of DATABASE_MIGRATIONS.entries()) {
    const created = collection.indexes[index];
    assert.ok(created, `index ${index} was not created`);
    assert.deepEqual(created.keys, migration.keys);
    assert.equal(created.options?.name, migration.name);
    assert.equal(created.options?.unique ?? false, migration.unique);
  }
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
  assert.match(log, /pass 108/);
  assert.match(log, /fail 0/);
  assert.match(log, /openapi\.json matches the published contracts/);
});
