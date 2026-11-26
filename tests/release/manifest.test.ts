import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseReleaseManifest, REPOSITORY, RELEASE_SCHEMA } from '../../scripts/release/manifest.js';

function committed(): string {
  return readFileSync(path.join(process.cwd(), 'release', 'train.json'), 'utf8');
}

function mutable(): Record<string, any> {
  return JSON.parse(committed()) as Record<string, any>;
}

test('the committed release train is a valid manifest for exactly three repositories', () => {
  const manifest = parseReleaseManifest(committed());
  assert.equal(manifest.schema, RELEASE_SCHEMA);
  assert.equal(manifest.engine.repository, REPOSITORY.engine);
  assert.equal(manifest.web.repository, REPOSITORY.web);
  assert.equal(manifest.cli.repository, REPOSITORY.cli);
  assert.match(manifest.engine.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.web.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.cli.commit, /^[0-9a-f]{40}$/);
  assert.ok(manifest.unpublished.length > 0, 'unpublished engine commits must be inventoried');
});

test('a branch name is not accepted as an immutable commit', () => {
  const raw = mutable();
  raw.engine.commit = 'main';
  assert.throws(() => parseReleaseManifest(JSON.stringify(raw)), /40-character lowercase commit SHA/);
});

test('a fourth repository is not representable', () => {
  const raw = mutable();
  raw.web.repository = 'Auctivon-CoderaxAI/Coderax-Second-Web';
  assert.throws(() => parseReleaseManifest(JSON.stringify(raw)), /Coderax-Second-Web|web must be/);
});

test('an integrated client must declare its SDK, contract, event schema and engine origin', () => {
  const raw = mutable();
  raw.web.integration.status = 'integrated';
  assert.throws(
    () => parseReleaseManifest(JSON.stringify(raw)),
    /integrated client must declare every compatibility field/,
  );
});

test('a cutover timestamp without an executed cutover is rejected', () => {
  const raw = mutable();
  raw.cutover.at = '2026-11-26T00:00:00.000Z';
  assert.throws(() => parseReleaseManifest(JSON.stringify(raw)), /unexecuted cutover cannot carry a timestamp/);
});

test('duplicate CI owner records are rejected', () => {
  const raw = mutable();
  raw.ci.ownerSignoffs[2].repository = REPOSITORY.engine;
  assert.throws(() => parseReleaseManifest(JSON.stringify(raw)), /exactly one CI owner sign-off/);
});

test('an unknown top-level field is rejected instead of ignored', () => {
  const raw = mutable();
  raw.surprise = true;
  assert.throws(() => parseReleaseManifest(JSON.stringify(raw)), /Unrecognized key/);
});
