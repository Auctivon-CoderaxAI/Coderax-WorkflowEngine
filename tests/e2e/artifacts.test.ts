import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { createFakeDatabase } from '../fakes/mongo.js';
import { base64, pngBytes, textBytes } from '../fixtures/artifacts.js';
import { fakeProvider, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('artifacts, versions and task links survive an engine restart and a new client', async () => {
  const database = createFakeDatabase();
  const provider = fakeProvider();
  const config = { persistence: { driver: 'mongo' } };
  const original = pngBytes('restart-proof');
  let artifactId = '';

  const first = await startTestApp({ provider, config, persistence: { database } });
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
    const callsAfterWork = provider.calls;
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
      mediaType: 'image/png',
      contentBase64: base64(pngBytes('version-two')),
      mode: 'cloud',
      note: 'refined palette',
    });
    assert.equal(second.artifact.version, 2);

    const linked = await api.artifacts({
      mode: 'cloud',
      taskId: accepted.taskId,
    });
    assert.deepEqual(
      linked.artifacts.map((entry) => entry.filename),
      ['chart-v2.png'],
    );
    assert.equal(linked.artifacts[0]?.sha256, second.version.sha256);

    const current = await api.downloadArtifact(artifactId, { mode: 'cloud' });
    assert.equal(current.contentBase64, base64(pngBytes('version-two')));
    const originalVersion = await api.downloadArtifact(artifactId, { mode: 'cloud', version: 1 });
    assert.equal(originalVersion.contentBase64, base64(original));

    const exported = await api.exportArtifact(artifactId, { mode: 'cloud', version: 1 });
    assert.equal(exported.versions.length, 2);
    assert.equal(exported.version.version, 1);
    assert.equal(exported.contentBase64, base64(original));

    // Reading artifacts never reaches the inference gateway.
    assert.equal(provider.calls, callsAfterWork);
  } finally {
    await first.close();
  }

  // A fresh process, a fresh client, the same durable rows.
  const second = await startTestApp({ provider, config, persistence: { database } });
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

test('a memory deployment fails closed over HTTP and reports the limitation', async () => {
  const started = await startTestApp({ config: { artifacts: { allowEphemeral: false } } });
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
