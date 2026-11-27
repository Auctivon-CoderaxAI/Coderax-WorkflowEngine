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

    const definitive = (message: string): Error => {
      const error = new Error(message) as Error & { definitive: boolean };
      error.definitive = true;
      return error;
    };
    const artifactInsert = artifacts.insertOne;
    artifacts.insertOne = async () => {
      throw definitive('injected artifact metadata failure');
    };
    await assert.rejects(upload, storageFailure);
    artifacts.insertOne = artifactInsert;
    await assertNothingKept();

    const versionInsert = versions.insertOne;
    versions.insertOne = async () => {
      throw definitive('injected version metadata failure');
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

test('project paths are unique and a manifest pins every file to its version', async () => {
  const database = createFakeDatabase();
  const started = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database },
  });
  try {
    const api = client(started.url);
    const upload = (
      relativePath: string,
      filename: string,
      body: string,
      mediaType: 'text/plain' | 'text/markdown' | 'application/json' = 'text/plain',
      kind: 'software' | 'document' = 'software',
    ) =>
      api.uploadArtifact({
        filename,
        relativePath,
        mediaType,
        kind,
        contentBase64: base64(textBytes(body)),
        mode: 'cloud',
        projectId: 'proj_manifest',
      });

    await upload('package.json', 'package.json', '{"name":"demo"}', 'application/json');
    await upload('README.md', 'README.md', '# demo', 'text/markdown', 'document');
    await upload('src/index.ts', 'index.ts', 'export const answer = 42;');

    const manifest = await api.artifactManifest('proj_manifest', 'cloud');
    assert.equal(manifest.files.length, 3);
    assert.deepEqual(
      manifest.files.map((file) => file.relativePath).sort(),
      ['README.md', 'package.json', 'src/index.ts'],
    );
    assert.match(manifest.digest, /^[0-9a-f]{64}$/);
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.equal(file.version, 1);
    }

    const conflict = (error: unknown) =>
      error instanceof CoderaxApiError && error.code === 'conflict';
    await assert.rejects(() => upload('src/index.ts', 'index.ts', 'duplicate'), conflict);
    await assert.rejects(() => upload('SRC/INDEX.ts', 'INDEX.ts', 'case fold'), conflict);
    await upload('café.md', 'café.md', 'nfc', 'text/markdown', 'document');
    await assert.rejects(
      () => upload('cafe\u0301.md', 'cafe\u0301.md', 'nfd', 'text/markdown', 'document'),
      conflict,
    );
    await upload('src.txt', 'src.txt', 'a file', 'text/plain', 'document');
    await assert.rejects(
      () => upload('src.txt/nested.md', 'nested.md', 'under a file', 'text/markdown', 'document'),
      conflict,
    );
    await assert.rejects(
      () =>
        api.uploadArtifact({
          filename: 'CON.txt',
          relativePath: 'CON.txt',
          mediaType: 'text/plain',
          contentBase64: base64(textBytes('reserved')),
          mode: 'cloud',
          projectId: 'proj_manifest',
        }),
      (error: unknown) =>
        error instanceof CoderaxApiError && error.code === 'validation_failed',
    );
    const deep = Array.from({ length: 65 }, (_, index) => `d${index}`).join('/');
    await assert.rejects(
      () =>
        api.uploadArtifact({
          filename: 'index.ts',
          relativePath: `${deep}/index.ts`,
          mediaType: 'text/plain',
          contentBase64: base64(textBytes('too deep')),
          mode: 'cloud',
          projectId: 'proj_manifest',
        }),
      (error: unknown) =>
        error instanceof CoderaxApiError && error.code === 'validation_failed',
    );
  } finally {
    await started.close();
  }
});

test('a version can be restored without deleting newer versions', async () => {
  const database = createFakeDatabase();
  const started = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database },
  });
  try {
    const api = client(started.url);
    const first = await api.uploadArtifact({
      filename: 'report.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('first')),
      mode: 'cloud',
    });
    await api.uploadArtifactVersion(first.artifact.artifactId, {
      filename: 'report-v2.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('second')),
      mode: 'cloud',
    });

    const restored = await api.restoreArtifactVersion(first.artifact.artifactId, {
      mode: 'cloud',
      version: 1,
      expectedVersion: 2,
    });
    assert.equal(restored.artifact.version, 1);
    assert.equal(restored.artifact.filename, 'report.txt');
    const bytes = await api.downloadArtifact(first.artifact.artifactId, {
      mode: 'cloud',
      version: 1,
    });
    assert.equal(bytes.contentBase64, base64(textBytes('first')));
    assert.equal((await api.artifactVersions(first.artifact.artifactId, 'cloud')).versions.length, 2);

    await assert.rejects(
      () =>
        api.restoreArtifactVersion(first.artifact.artifactId, {
          mode: 'cloud',
          version: 1,
          expectedVersion: 2,
        }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'conflict',
    );

    const appended = await api.uploadArtifactVersion(first.artifact.artifactId, {
      filename: 'report-v3.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('third')),
      mode: 'cloud',
      expectedVersion: 1,
    });
    assert.equal(appended.artifact.version, 3);
    const history = await api.artifactVersions(first.artifact.artifactId, 'cloud');
    assert.deepEqual(history.versions.map((entry) => entry.version), [1, 2, 3]);
  } finally {
    await started.close();
  }
});

test('an ambiguous metadata failure keeps its reference and admission for recovery', async () => {
  const database = createFakeDatabase();
  const started = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database },
  });
  try {
    const api = client(started.url);
    const artifacts = database.collection('artifacts');
    artifacts.insertOne = async () => {
      throw new Error('ambiguous driver failure after an unknown commit outcome');
    };

    await assert.rejects(
      () =>
        api.uploadArtifact({
          filename: 'ambiguous.png',
          mediaType: 'image/png',
          contentBase64: base64(pngBytes('ambiguous')),
          mode: 'cloud',
        }),
      (error: unknown) =>
        error instanceof CoderaxApiError && error.code === 'storage_unavailable',
    );
    assert.equal((await artifacts.find({}).toArray()).length, 0);
    assert.equal(
      (await database.collection('artifact_versions').find({}).toArray()).length,
      0,
    );
    // The write may have landed somewhere: neither the reference nor the
    // admission is refunded. A reservation expiry settles the quota and leak
    // reclamation settles the blob if no version row was ever committed.
    assert.equal((await database.collection('artifact_blobs').find({}).toArray()).length, 1);
    const capacity = await database
      .collection('artifact_capacity')
      .findOne({ mode: 'cloud' });
    assert.ok(
      typeof capacity?.availableBytes === 'number' &&
        capacity.availableBytes < artifactSettings().maxBytesPerOwner,
    );
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

test('a lost refund acknowledgement resumes deletion without releasing the shared blob twice', async () => {
  const database = createFakeDatabase();
  const app = await startTestApp({ config: { persistence: { driver: 'mongo' } }, persistence: { database } });
  try {
    const api = client(app.url);
    const request = { filename: 'one.txt', mediaType: 'text/plain' as const, contentBase64: base64(textBytes('shared')) };
    const first = await api.uploadArtifact(request);
    const second = await api.uploadArtifact({ ...request, filename: 'two.txt' });
    const capacity = database.collection('artifact_capacity');
    const update = capacity.updateOne.bind(capacity);
    let injected = false;
    capacity.updateOne = async (filter, mutation, options) => {
      const applied = await update(filter, mutation, options);
      if (!injected && mutation.$pull?.tickets) {
        injected = true;
        throw new Error('lost refund acknowledgement');
      }
      return applied;
    };
    await assert.rejects(api.deleteArtifact(first.artifact.artifactId));
    assert.ok(injected);
    await app.app.service.artifacts.sweepExpiredArtifacts();
    await app.app.service.artifacts.sweepExpiredArtifacts();
    assert.equal((await api.downloadArtifact(second.artifact.artifactId)).contentBase64, request.contentBase64);
    const counter = await capacity.findOne({ mode: 'private' });
    assert.equal(counter?.availableArtifacts, artifactSettings().maxArtifactsPerOwner - 1);
    assert.equal(counter?.availableBytes, artifactSettings().maxBytesPerOwner - second.artifact.bytes);
  } finally {
    await app.close();
  }
});
