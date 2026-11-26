import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createArtifactRepository,
  createArtifactStorage,
  digestOf,
} from '../../src/artifacts/store.js';

function roots(): { private: string; cloud: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-artifacts-'));
  const privateRoot = path.join(root, 'private');
  const cloudRoot = path.join(root, 'cloud');
  mkdirSync(privateRoot);
  mkdirSync(cloudRoot);
  return {
    private: privateRoot,
    cloud: cloudRoot,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('artifact bytes round-trip with a verified digest', async () => {
  const workspace = roots();
  try {
    const storage = createArtifactStorage({ private: workspace.private, cloud: workspace.cloud });
    const content = Buffer.from('artifact bytes that must round-trip\n', 'utf8');
    const stored = await storage.write({ mode: 'cloud', artifactId: 'art_1', content });
    assert.equal(stored.bytes, content.length);
    assert.equal(stored.digest, digestOf(content));
    const read = await storage.read({
      mode: 'cloud',
      artifactId: 'art_1',
      digest: stored.digest,
    });
    assert.deepEqual(read, content);
  } finally {
    workspace.cleanup();
  }
});

test('tampering with stored bytes is detected instead of returned', async () => {
  const workspace = roots();
  try {
    const storage = createArtifactStorage({ private: workspace.private, cloud: workspace.cloud });
    const stored = await storage.write({
      mode: 'cloud',
      artifactId: 'art_tamper',
      content: Buffer.from('original'),
    });
    writeFileSync(path.join(workspace.cloud, '.coderax-artifacts', 'art_tamper.bin'), 'tampered');
    await assert.rejects(
      () => storage.read({ mode: 'cloud', artifactId: 'art_tamper', digest: stored.digest }),
      /does not match its recorded digest/,
    );
  } finally {
    workspace.cleanup();
  }
});

test('an artifact identifier cannot escape the artifact root', async () => {
  const workspace = roots();
  try {
    const storage = createArtifactStorage({ private: workspace.private, cloud: workspace.cloud });
    await assert.rejects(
      () => storage.write({ mode: 'cloud', artifactId: '../escape', content: Buffer.from('x') }),
      /not a safe file name/,
    );
  } finally {
    workspace.cleanup();
  }
});

test('the process-local artifact repository scopes reads to the owner and task', async () => {
  const repository = createArtifactRepository();
  await repository.insert({
    artifactId: 'art_1',
    ownerId: 'owner-test',
    taskId: 'task_1',
    path: 'notes/release.txt',
    mediaType: 'text/plain',
    bytes: 4,
    digest: `sha256:${'a'.repeat(64)}`,
    mode: 'private',
    createdAt: '2026-11-26T12:00:00.000Z',
  });
  assert.equal((await repository.get('owner-test', 'art_1'))?.taskId, 'task_1');
  assert.equal(await repository.get('another-owner', 'art_1'), null);
  assert.equal((await repository.list('owner-test', 'task_1')).length, 1);
  assert.equal((await repository.list('owner-test', 'task_2')).length, 0);
});
