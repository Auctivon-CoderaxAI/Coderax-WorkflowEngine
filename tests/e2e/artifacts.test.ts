import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { createFakeDatabase } from '../fakes/mongo.js';
import { artifactSettings, base64, pngBytes, textBytes } from '../fixtures/artifacts.js';
import { fakeGateway, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('artifacts, versions and task links survive an engine restart and a new client', async () => {
  const database = createFakeDatabase();
  const gateway = fakeGateway();
  const config = { persistence: { driver: 'mongo' } };
  const original = pngBytes('restart-proof');
  let artifactId = '';

  const first = await startTestApp({ gateway, config, persistence: { database } });
  try {
    const api = client(first.url);
    const accepted = await api.submitWork({
      objective: 'Generate a chart for the dashboard',
      mode: 'cloud',
      requireApproval: true,
    });
    await waitFor(async () => {
      const status = await api.task(accepted.taskId);
      return status.state === 'completed' ? status : null;
    });
    const callsAfterWork = gateway.calls;
    assert.ok(callsAfterWork > 0);

    const uploaded = await api.uploadArtifact({
      filename: 'chart.png',
      mediaType: 'image/png',
      contentBase64: base64(original),
      mode: 'cloud',
      projectId: 'proj_dashboard',
      taskId: accepted.taskId,
      conversationId: accepted.conversationId,
    });
    artifactId = uploaded.artifact.artifactId;
    assert.equal(uploaded.artifact.inferenceExposure, 'none');
    assert.equal(uploaded.artifact.sha256, uploaded.version.sha256);

    const second = await api.uploadArtifactVersion(artifactId, {
      filename: 'chart-v2.png',
      relativePath: 'charts/chart-v2.png',
      mediaType: 'image/png',
      contentBase64: base64(pngBytes('version-two')),
      mode: 'cloud',
      note: 'refined palette',
    });
    assert.equal(second.artifact.version, 2);
    assert.equal(second.version.relativePath, 'charts/chart-v2.png');

    const status = await api.task(accepted.taskId);
    assert.deepEqual(
      status.result?.artifacts.map((entry) => entry.path),
      ['charts/chart-v2.png'],
    );
    assert.equal(status.result?.artifacts[0]?.digest, second.version.sha256);

    const current = await api.downloadArtifact(artifactId, { mode: 'cloud' });
    assert.equal(current.contentBase64, base64(pngBytes('version-two')));
    const originalVersion = await api.downloadArtifact(artifactId, { mode: 'cloud', version: 1 });
    assert.equal(originalVersion.contentBase64, base64(original));

    const exported = await api.exportArtifact(artifactId, { mode: 'cloud', version: 1 });
    assert.equal(exported.versions.length, 2);
    assert.equal(exported.version.version, 1);
    assert.equal(exported.contentBase64, base64(original));

    // Reading artifacts never reaches the inference gateway.
    assert.equal(gateway.calls, callsAfterWork);
  } finally {
    await first.close();
  }

  // A fresh process, a fresh client, the same durable rows.
  const second = await startTestApp({ gateway, config, persistence: { database } });
  try {
    const api = client(second.url);
    const persisted = await api.artifact(artifactId, 'cloud');
    assert.equal(persisted.version, 2);
    assert.equal(persisted.projectId, 'proj_dashboard');
    assert.equal(persisted.versions, 2);
    const fromDisk = await api.downloadArtifact(artifactId, { mode: 'cloud', version: 1 });
    assert.equal(fromDisk.contentBase64, base64(original));

    await assert.rejects(
      () => api.artifact(artifactId, 'private'),
      (error: unknown) => error instanceof CoderaxApiError && error.status === 404,
    );
    await assert.rejects(
      () => api.downloadArtifact(artifactId, { mode: 'private' }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
    );

    const deleted = await api.deleteArtifact(artifactId, 'cloud');
    assert.equal(deleted.deletedVersions, 2);
    await assert.rejects(
      () => api.downloadArtifact(artifactId, { mode: 'cloud' }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
    );
    assert.equal((await api.artifacts({ mode: 'cloud' })).artifacts.length, 0);
  } finally {
    await second.close();
  }
});

test('a generated source tree is persisted file by file and listed as a manifest', async () => {
  const database = createFakeDatabase();
  const started = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database },
  });
  try {
    const api = client(started.url);
    const files = [
      {
        filename: 'package.json',
        relativePath: 'package.json',
        mediaType: 'application/json' as const,
        contentBase64: base64(textBytes('{"name":"demo","private":true}')),
        kind: 'software' as const,
      },
      {
        filename: 'index.ts',
        relativePath: 'src/index.ts',
        mediaType: 'text/plain' as const,
        contentBase64: base64(textBytes('export const answer = 42;\n')),
        kind: 'software' as const,
      },
      {
        filename: 'index.test.ts',
        relativePath: 'test/index.test.ts',
        mediaType: 'text/plain' as const,
        contentBase64: base64(textBytes('import { answer } from "../src/index.ts";\n')),
        kind: 'software' as const,
      },
    ];
    const uploaded = [];
    for (const file of files) {
      const result = await api.uploadArtifact({
        ...file,
        mode: 'cloud',
        projectId: 'proj_source_tree',
      });
      uploaded.push(result);
    }

    const listed = await api.artifacts({ mode: 'cloud', projectId: 'proj_source_tree' });
    assert.deepEqual(
      listed.artifacts.map((entry) => entry.relativePath).sort(),
      ['package.json', 'src/index.ts', 'test/index.test.ts'],
    );
    assert.deepEqual(
      listed.artifacts.map((entry) => entry.filename).sort(),
      ['index.test.ts', 'index.ts', 'package.json'],
    );

    const source = uploaded.find((entry) => entry.version.relativePath === 'src/index.ts');
    assert.ok(source);
    const downloaded = await api.downloadArtifact(source.artifact.artifactId, {
      mode: 'cloud',
    });
    assert.equal(downloaded.contentBase64, base64(textBytes('export const answer = 42;\n')));

    await assert.rejects(
      () =>
        api.uploadArtifact({
          filename: 'escape.txt',
          relativePath: '../escape.txt',
          mediaType: 'text/plain',
          contentBase64: base64(textBytes('escape')),
          mode: 'cloud',
        }),
      (error: unknown) =>
        error instanceof CoderaxApiError && error.code === 'validation_failed',
    );
  } finally {
    await started.close();
  }
});

test('a failed metadata write releases the reference, the admission and the rows', async () => {
  const database = createFakeDatabase();
  const started = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database },
  });
  try {
    const api = client(started.url);
    const content = pngBytes('injected-failure');
    const artifacts = database.collection('artifacts');
    const versions = database.collection('artifact_versions');
    const capacity = () => database.collection('artifact_capacity').findOne({ mode: 'cloud' });

    const upload = () =>
      api.uploadArtifact({
        filename: 'lost.png',
        mediaType: 'image/png',
        contentBase64: base64(content),
        mode: 'cloud',
      });
    const storageFailure = (error: unknown) =>
      error instanceof CoderaxApiError && error.code === 'storage_unavailable';
    const assertNothingKept = async () => {
      assert.equal((await database.collection('artifact_blobs').find({}).toArray()).length, 0);
      assert.equal((await database.collection('artifact_chunks').find({}).toArray()).length, 0);
      assert.equal((await versions.find({}).toArray()).length, 0);
      assert.equal((await artifacts.find({}).toArray()).length, 0);
      assert.equal((await capacity())?.availableBytes, artifactSettings().maxBytesPerOwner);
      assert.equal((await capacity())?.availableArtifacts, artifactSettings().maxArtifactsPerOwner);
    };

    const artifactInsert = artifacts.insertOne;
    artifacts.insertOne = async () => {
      throw new Error('injected artifact metadata failure');
    };
    await assert.rejects(upload, storageFailure);
    artifacts.insertOne = artifactInsert;
    await assertNothingKept();

    const versionInsert = versions.insertOne;
    versions.insertOne = async () => {
      throw new Error('injected version metadata failure');
    };
    await assert.rejects(upload, storageFailure);
    versions.insertOne = versionInsert;
    await assertNothingKept();

    const retried = await upload();
    const downloaded = await api.downloadArtifact(retried.artifact.artifactId, { mode: 'cloud' });
    assert.equal(downloaded.contentBase64, base64(content));
  } finally {
    await started.close();
  }
});

test('a memory deployment fails closed over HTTP and reports the limitation', async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    await assert.rejects(
      () =>
        api.uploadArtifact({
          filename: 'notes.txt',
          mediaType: 'text/plain',
          contentBase64: base64(textBytes('lost on restart')),
          mode: 'private',
        }),
      (error: unknown) =>
        error instanceof CoderaxApiError &&
        error.code === 'storage_unavailable' &&
        error.status === 503,
    );
    const listed = await api.artifacts({ mode: 'private' });
    assert.equal(listed.artifacts.length, 0);

    const health = await api.health();
    const artifactsCheck = health.checks.find((check) => check.name === 'artifacts');
    assert.ok(artifactsCheck);
    assert.match(artifactsCheck.detail ?? '', /uploads are refused/);
  } finally {
    await started.close();
  }
});

test('artifact routes require the owner token and validate the media allowlist', async () => {
  const started = await startTestApp();
  try {
    const list = await fetch(`${started.url}/v1/artifacts`);
    assert.equal(list.status, 401);

    const upload = await fetch(`${started.url}/v1/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'notes.txt',
        mediaType: 'text/plain',
        contentBase64: base64(textBytes('unauthenticated')),
      }),
    });
    assert.equal(upload.status, 401);

    const api = client(started.url);
    await assert.rejects(
      () =>
        api.uploadArtifact({
          filename: 'bundle.zip',
          mediaType: 'application/zip' as never,
          contentBase64: base64(textBytes('archive')),
          mode: 'private',
        }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'validation_failed',
    );
  } finally {
    await started.close();
  }
});
