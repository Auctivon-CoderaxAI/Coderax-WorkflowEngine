import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactUploadRequest } from '@coderax/contracts';
import type { ServiceResult } from '../../src/support/result.js';
import {
  artifactHarness,
  base64,
  ooxmlBytes,
  pdfBytes,
  pngBytes,
  textBytes,
  zipBytes,
} from '../fixtures/artifacts.js';
import { OWNER_ID, taskRecord } from '../helpers.js';

function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.detail}`);
  return result.value;
}

function expectFailure<T>(result: ServiceResult<T>, code: string): void {
  assert.equal(result.ok, false, `expected ${code}, got success`);
  if (!result.ok) assert.equal(result.code, code);
}

function upload(overrides: Partial<ArtifactUploadRequest> = {}): ArtifactUploadRequest {
  return {
    filename: 'notes.txt',
    mediaType: 'text/plain',
    contentBase64: base64(textBytes('durable artifact content')),
    mode: 'cloud',
    ...overrides,
  };
}

test('a non-durable deployment refuses writes instead of losing them', async () => {
  const harness = artifactHarness({ durable: false });
  assert.equal(harness.service.durable, false);

  expectFailure(await harness.service.upload(harness.owner, upload()), 'storage_unavailable');
  expectFailure(
    await harness.service.addVersion(harness.owner, 'art_missing', {
      filename: 'notes.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('more')),
      mode: 'cloud',
    }),
    'storage_unavailable',
  );

  const listed = unwrap(await harness.service.list(harness.owner, { mode: 'cloud' }));
  assert.equal(listed.artifacts.length, 0);
  assert.equal(listed.quota.usedBytes, 0);
});

test('owner and data mode are part of every lookup', async () => {
  const harness = artifactHarness();
  const stored = unwrap(await harness.service.upload(harness.owner, upload()));
  const artifactId = stored.artifact.artifactId;

  assert.equal(unwrap(await harness.service.get(harness.owner, artifactId, 'cloud')).artifactId, artifactId);
  expectFailure(await harness.service.get(harness.owner, artifactId, 'private'), 'not_found');
  expectFailure(await harness.service.get(harness.other, artifactId, 'cloud'), 'not_found');
  expectFailure(
    await harness.service.download(harness.other, artifactId, { mode: 'cloud' }),
    'not_found',
  );
  expectFailure(
    await harness.service.download(harness.owner, artifactId, { mode: 'private' }),
    'not_found',
  );
  expectFailure(await harness.service.remove(harness.other, artifactId, 'cloud'), 'not_found');
  assert.equal(unwrap(await harness.service.list(harness.owner, { mode: 'private' })).artifacts.length, 0);
});

test('artifact byte and count quotas are hard refusals', async () => {
  const bytes = artifactHarness({
    settings: { maxBytesPerArtifact: 1_024, maxBytesPerOwner: 1_500, maxArtifactsPerOwner: 10 },
  });
  unwrap(
    await bytes.service.upload(
      bytes.owner,
      upload({ filename: 'a.txt', contentBase64: base64(textBytes('a'.repeat(600))) }),
    ),
  );
  unwrap(
    await bytes.service.upload(
      bytes.owner,
      upload({ filename: 'b.txt', contentBase64: base64(textBytes('b'.repeat(600))) }),
    ),
  );
  expectFailure(
    await bytes.service.upload(
      bytes.owner,
      upload({ filename: 'c.txt', contentBase64: base64(textBytes('c'.repeat(600))) }),
    ),
    'quota_exceeded',
  );
  expectFailure(
    await bytes.service.upload(
      bytes.owner,
      upload({ filename: 'big.txt', contentBase64: base64(textBytes('x'.repeat(1_100))) }),
    ),
    'payload_too_large',
  );

  const count = artifactHarness({ settings: { maxArtifactsPerOwner: 1 } });
  unwrap(await count.service.upload(count.owner, upload({ filename: 'one.txt' })));
  expectFailure(
    await count.service.upload(count.owner, upload({ filename: 'two.txt' })),
    'quota_exceeded',
  );
});

test('versions are immutable, bounded and individually downloadable', async () => {
  const harness = artifactHarness({ settings: { maxVersionsPerArtifact: 2 } });
  const first = unwrap(
    await harness.service.upload(harness.owner, upload({ contentBase64: base64(textBytes('version one')) })),
  );
  const artifactId = first.artifact.artifactId;

  unwrap(
    await harness.service.addVersion(harness.owner, artifactId, {
      filename: 'notes-v2.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('version two')),
      mode: 'cloud',
      note: 'second',
    }),
  );
  const third = unwrap(
    await harness.service.addVersion(harness.owner, artifactId, {
      filename: 'notes-v3.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('version three')),
      mode: 'cloud',
    }),
  );
  assert.equal(third.artifact.version, 3);
  assert.equal(third.artifact.versions, 2);

  const versions = unwrap(await harness.service.versions(harness.owner, artifactId, 'cloud'));
  assert.deepEqual(
    versions.versions.map((entry) => entry.version),
    [2, 3],
  );

  const second = unwrap(
    await harness.service.download(harness.owner, artifactId, { mode: 'cloud', version: 2 }),
  );
  assert.equal(Buffer.from(second.contentBase64, 'base64').toString('utf8'), 'version two');
  expectFailure(
    await harness.service.download(harness.owner, artifactId, { mode: 'cloud', version: 1 }),
    'not_found',
  );
  expectFailure(
    await harness.service.addVersion(harness.owner, 'art_missing', {
      filename: 'x.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('x')),
      mode: 'cloud',
    }),
    'not_found',
  );
});

test('retention expires artifacts and the sweep releases their bytes', async () => {
  const harness = artifactHarness({ settings: { maxRetentionDays: 30 } });
  const expiring = unwrap(
    await harness.service.upload(
      harness.owner,
      upload({ filename: 'short.txt', retentionDays: 30 }),
    ),
  );
  assert.ok(expiring.artifact.expiresAt);
  expectFailure(
    await harness.service.upload(harness.owner, upload({ filename: 'long.txt', retentionDays: 31 })),
    'validation_failed',
  );

  const permanent = unwrap(
    await harness.service.upload(harness.owner, upload({ filename: 'forever.txt' })),
  );
  assert.equal(permanent.artifact.expiresAt, undefined);

  harness.clock.advance(31 * 86_400_000);
  const pruned = unwrap(await harness.service.prune(harness.owner, 'cloud'));
  assert.equal(pruned.pruned, 1);
  assert.equal(pruned.releasedBytes, expiring.artifact.bytes);
  expectFailure(
    await harness.service.get(harness.owner, expiring.artifact.artifactId, 'cloud'),
    'not_found',
  );
  assert.equal(
    unwrap(await harness.service.get(harness.owner, permanent.artifact.artifactId, 'cloud')).artifactId,
    permanent.artifact.artifactId,
  );
});

test('startup sweeps expired artifacts across owners without touching live ones', async () => {
  const harness = artifactHarness();
  unwrap(
    await harness.service.upload(harness.owner, upload({ filename: 'soon.txt', retentionDays: 1 })),
  );
  unwrap(
    await harness.service.upload(harness.owner, upload({ filename: 'later.txt', retentionDays: 10 })),
  );
  harness.clock.advance(2 * 86_400_000);
  const swept = await harness.service.sweepExpiredArtifacts();
  assert.equal(swept.pruned, 1);
  assert.equal(unwrap(await harness.service.list(harness.owner, { mode: 'cloud' })).artifacts.length, 1);
});

test('delete removes every version and the unreferenced content', async () => {
  const harness = artifactHarness();
  const first = unwrap(
    await harness.service.upload(harness.owner, upload({ contentBase64: base64(textBytes('one')) })),
  );
  const artifactId = first.artifact.artifactId;
  const second = unwrap(
    await harness.service.addVersion(harness.owner, artifactId, {
      filename: 'notes-v2.txt',
      mediaType: 'text/plain',
      contentBase64: base64(textBytes('two')),
      mode: 'cloud',
    }),
  );

  const exported = unwrap(await harness.service.exportBundle(harness.owner, artifactId, { mode: 'cloud' }));
  assert.equal(exported.versions.length, 2);
  assert.equal(exported.version.version, 2);
  assert.equal(Buffer.from(exported.contentBase64, 'base64').toString('utf8'), 'two');
  assert.equal(Buffer.from(unwrap(await harness.service.download(harness.owner, artifactId, { mode: 'cloud', version: 1 })).contentBase64, 'base64').toString('utf8'), 'one');

  const deleted = unwrap(await harness.service.remove(harness.owner, artifactId, 'cloud'));
  assert.equal(deleted.deletedVersions, 2);
  assert.equal(deleted.releasedBytes, first.artifact.bytes + second.version.bytes);
  assert.equal(
    await harness.blobs.get({
      ownerId: OWNER_ID,
      mode: 'cloud',
      sha256: first.artifact.sha256,
    }),
    null,
  );
  expectFailure(await harness.service.remove(harness.owner, artifactId, 'cloud'), 'not_found');
});

test('conversation, task and project associations are verified, not trusted', async () => {
  const harness = artifactHarness();
  const now = harness.clock.iso();
  for (const [conversationId, mode] of [
    ['conv_cloud', 'cloud'],
    ['conv_other', 'cloud'],
    ['conv_private', 'private'],
  ] as const) {
    await harness.conversations.ensure({
      conversationId,
      ownerId: OWNER_ID,
      tenantId: null,
      mode,
      isWork: false,
      agent: 'coderax',
      createdAt: now,
      updatedAt: now,
    });
  }
  await harness.tasks.create(
    taskRecord({ taskId: 'task_cloud', conversationId: 'conv_cloud', mode: 'cloud' }),
  );
  await harness.tasks.create(
    taskRecord({ taskId: 'task_private', conversationId: 'conv_private', mode: 'private' }),
  );

  const associated = unwrap(
    await harness.service.upload(
      harness.owner,
      upload({ filename: 'result.txt', conversationId: 'conv_cloud', taskId: 'task_cloud' }),
    ),
  );
  assert.equal(associated.artifact.conversationId, 'conv_cloud');
  assert.equal(associated.artifact.taskId, 'task_cloud');

  expectFailure(
    await harness.service.upload(harness.owner, upload({ filename: 'x.txt', conversationId: 'conv_private' })),
    'not_found',
  );
  expectFailure(
    await harness.service.upload(harness.owner, upload({ filename: 'x.txt', taskId: 'task_private' })),
    'not_found',
  );
  expectFailure(
    await harness.service.upload(
      harness.owner,
      upload({ filename: 'x.txt', taskId: 'task_cloud', conversationId: 'conv_other' }),
    ),
    'validation_failed',
  );

  expectFailure(
    await harness.service.upload(
      harness.owner,
      upload({
        filename: 'project.json',
        mediaType: 'application/json',
        contentBase64: base64(textBytes('{"name":"coderax"}')),
        kind: 'project',
      }),
    ),
    'validation_failed',
  );
  const project = unwrap(
    await harness.service.upload(
      harness.owner,
      upload({
        filename: 'project.json',
        mediaType: 'application/json',
        contentBase64: base64(textBytes('{"name":"coderax"}')),
        kind: 'project',
        projectId: 'proj_1',
      }),
    ),
  );
  assert.equal(project.artifact.kind, 'project');
  assert.equal(project.artifact.inferenceExposure, 'none');
});

test('malicious names, archives, spoofed types and bad digests never reach storage', async () => {
  const harness = artifactHarness();
  expectFailure(
    await harness.service.upload(harness.owner, upload({ filename: '../../etc/passwd.txt' })),
    'validation_failed',
  );
  expectFailure(
    await harness.service.upload(
      harness.owner,
      upload({
        filename: 'naughty.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentBase64: base64(zipBytes()),
      }),
    ),
    'unsupported_media_type',
  );
  expectFailure(
    await harness.service.upload(
      harness.owner,
      upload({ filename: 'spoofed.png', mediaType: 'image/png', contentBase64: base64(pdfBytes()) }),
    ),
    'unsupported_media_type',
  );
  expectFailure(
    await harness.service.upload(
      harness.owner,
      upload({
        filename: 'page.html',
        contentBase64: base64(textBytes('<html></html>')),
      }),
    ),
    'unsupported_media_type',
  );
  expectFailure(
    await harness.service.upload(
      harness.owner,
      upload({ filename: 'chart.png', mediaType: 'image/png', contentBase64: base64(pngBytes()), sha256: 'c'.repeat(64) }),
    ),
    'validation_failed',
  );
  expectFailure(
    await harness.service.upload(
      harness.owner,
      upload({ filename: 'broken.txt', contentBase64: 'not base64 !!!' }),
    ),
    'validation_failed',
  );

  assert.equal(unwrap(await harness.service.list(harness.owner, { mode: 'cloud' })).artifacts.length, 0);
  assert.equal(harness.blobs.durable, true);
});

test('the audit log records the action without becoming a copy of the file name', async () => {
  const harness = artifactHarness();
  unwrap(await harness.service.upload(harness.owner, upload({ filename: 'private-plan.txt' })));
  const records = harness.audit.list();
  const stored = records.find((record) => record.action === 'artifact.stored');
  assert.ok(stored);
  assert.equal(stored.detail?.includes('private-plan.txt'), false);
  assert.match(stored.detail ?? '', /sha256=/);
});

test('valid office and media artifacts are accepted without exposing inference', async () => {
  const harness = artifactHarness();
  const xlsx = unwrap(
    await harness.service.upload(
      harness.owner,
      upload({
        filename: 'budget.xlsx',
        mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        contentBase64: base64(ooxmlBytes('xlsx')),
        kind: 'spreadsheet',
      }),
    ),
  );
  assert.equal(xlsx.artifact.kind, 'spreadsheet');
  assert.equal(xlsx.artifact.inferenceExposure, 'none');
  assert.equal(xlsx.version.kind, 'spreadsheet');
});
