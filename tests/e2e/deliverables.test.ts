import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { createFakeDatabase } from '../fakes/mongo.js';
import { fakeGateway, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

const BLOCKS = [
  { type: 'heading' as const, level: 1 as const, text: 'Scope' },
  { type: 'paragraph' as const, text: 'The engine produces real files and verifies them.' },
  { type: 'table' as const, headers: ['Check', 'Result'], rows: [['DOCX', 'read back']] },
];

test('a deliverable is stored, revised by artifact id, versioned, restarted and deleted', async () => {
  const database = createFakeDatabase();
  const config = { persistence: { driver: 'mongo' } };
  const first = await startTestApp({ config, persistence: { database } });
  const api = client(first.url);
  try {
    const created = await api.deliver({
      kind: 'document',
      mode: 'cloud',
      filename: 'spec',
      title: 'Specification',
      blocks: BLOCKS,
      formats: ['docx', 'pdf', 'markdown'],
    });

    assert.equal(created.kind, 'document');
    assert.equal(created.artifacts.length, 4, 'three formats and the editable source');
    assert.ok(created.source, 'the editable source is reported by artifact id');
    assert.equal(created.source?.format, 'document.json');
    assert.equal(created.verification.ok, true);
    assert.ok(created.receipt.receiptId.startsWith('rcpt_'));
    for (const artifact of created.artifacts) {
      assert.equal(artifact.inferenceExposure, 'none');
      assert.equal(artifact.mode, 'cloud');
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    }

    const docx = created.artifacts.find((artifact) => artifact.filename === 'spec.docx');
    assert.ok(docx, 'the DOCX descriptor is present');
    const firstBytes = await api.downloadArtifact(docx.artifactId, { mode: 'cloud' });
    const firstContent = Buffer.from(firstBytes.contentBase64, 'base64');
    assert.equal(firstContent.subarray(0, 2).toString(), 'PK');
    assert.equal(firstBytes.version.sha256, docx.sha256);

    // Revision is addressed by artifact id, with the version the client read.
    const revised = await api.deliver({
      kind: 'document',
      mode: 'cloud',
      filename: 'spec',
      title: 'Specification (revised)',
      blocks: [],
      formats: ['docx', 'pdf', 'markdown'],
      base: {
        artifactId: created.source!.artifactId,
        mode: 'cloud',
        expectedVersion: created.source!.version,
      },
      edits: [{ op: 'append', blocks: [{ type: 'paragraph', text: 'Added after review.' }] }],
    });
    assert.equal(revised.source?.artifactId, created.source!.artifactId);
    assert.equal(revised.source?.version, created.source!.version + 1);

    const revisedDocx = revised.artifacts.find((artifact) => artifact.filename === 'spec.docx');
    assert.ok(revisedDocx);
    assert.equal(revisedDocx.artifactId, docx.artifactId, 'the same artifact gained a version');
    assert.equal(revisedDocx.version, 2);

    const history = await api.artifactVersions(docx.artifactId, 'cloud');
    assert.deepEqual(
      history.versions.map((version) => version.version),
      [1, 2],
    );

    // The first version is still retrievable after the edit.
    const previous = await api.downloadArtifact(docx.artifactId, { mode: 'cloud', version: 1 });
    assert.equal(previous.version.sha256, docx.sha256);
    assert.equal(
      Buffer.from(previous.contentBase64, 'base64').length,
      firstContent.length,
    );

    // A second edit built on the stale version is refused, not silently applied.
    await assert.rejects(
      api.deliver({
        kind: 'document',
        mode: 'cloud',
        filename: 'spec',
        title: 'Specification (stale)',
        blocks: [],
        formats: ['docx'],
        base: {
          artifactId: created.source!.artifactId,
          mode: 'cloud',
          expectedVersion: created.source!.version,
        },
        edits: [{ op: 'append', blocks: [{ type: 'paragraph', text: 'Stale write.' }] }],
      }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'conflict',
    );

    // The bytes outlive the process that produced them.
    await first.close();
    const second = await startTestApp({ config, persistence: { database } });
    const restarted = client(second.url);
    try {
      const afterRestart = await restarted.downloadArtifact(docx.artifactId, {
        mode: 'cloud',
        version: 2,
      });
      assert.equal(afterRestart.artifact.sha256, revisedDocx.sha256);
      assert.ok(Buffer.from(afterRestart.contentBase64, 'base64').length > 0);

      // The other data-mode partition reports the artifact as absent.
      await assert.rejects(
        restarted.downloadArtifact(docx.artifactId, { mode: 'private' }),
        (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
      );

      const deleted = await restarted.deleteArtifact(created.source!.artifactId, 'cloud');
      assert.equal(deleted.deletedVersions, 2);
      await assert.rejects(
        restarted.downloadArtifact(created.source!.artifactId, { mode: 'cloud' }),
        (error: unknown) => error instanceof CoderaxApiError && error.code === 'not_found',
      );
    } finally {
      await second.close();
    }
  } catch (error) {
    await first.close().catch(() => undefined);
    throw error;
  }
});

test('a dataset and a software project are stored as descriptors, not paths', async () => {
  const first = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database: createFakeDatabase() },
  });
  try {
    const api = client(first.url);
    const dataset = await api.deliver({
      kind: 'dataset',
      mode: 'cloud',
      filename: 'orders',
      source: { format: 'csv', text: 'region,amount\nnorth,10\nsouth,20\n' },
      steps: [{ op: 'sort', column: 'amount', direction: 'desc' }],
      exports: ['csv', 'tsv', 'json'],
    });
    assert.equal(dataset.analysis?.rowsOut, 2);
    assert.deepEqual(
      dataset.artifacts.map((artifact) => artifact.filename).sort(),
      ['orders.analysis.json', 'orders.csv', 'orders.recipe.json', 'orders.tsv'],
    );
    for (const artifact of dataset.artifacts) {
      assert.ok(artifact.artifactId.startsWith('art_'));
      assert.ok(!artifact.filename.includes('/'));
    }

    const software = await api.deliver({
      kind: 'software',
      mode: 'cloud',
      name: 'toolkit-demo',
      description: 'A small generated module.',
      template: 'module',
      language: 'javascript',
      files: [],
    });
    assert.ok(software.source, 'a project manifest artifact is reported');
    assert.equal(software.source?.format, 'project.json');
    const manifest = await api.downloadArtifact(software.source!.artifactId, { mode: 'cloud' });
    const parsed = JSON.parse(Buffer.from(manifest.contentBase64, 'base64').toString()) as {
      version: number;
      entry: string;
      files: Array<{ path: string; artifactId: string; sha256: string }>;
    };
    assert.equal(parsed.version, 1);
    assert.ok(parsed.files.length > 0);
    for (const file of parsed.files) {
      assert.ok(file.artifactId.startsWith('art_'));
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(!file.path.startsWith('/'));
      assert.ok(!file.path.split('/').includes('..'));
    }
  } finally {
    await first.close();
  }
});

test('exhausting the artifact quota fails the deliverable and leaves nothing behind', async () => {
  const first = await startTestApp({
    config: {
      persistence: { driver: 'mongo' },
      artifacts: { maxBytesPerOwner: 4_096 },
    },
    persistence: { database: createFakeDatabase() },
  });
  try {
    const api = client(first.url);
    await assert.rejects(
      api.deliver({
        kind: 'document',
        mode: 'cloud',
        filename: 'large',
        title: 'Large',
        blocks: [
          { type: 'paragraph', text: 'x'.repeat(20_000) },
        ],
        formats: ['docx', 'pdf', 'markdown'],
      }),
      (error: unknown) =>
        error instanceof CoderaxApiError &&
        (error.code === 'quota_exceeded' || error.code === 'payload_too_large'),
    );
    const listed = await api.artifacts({ mode: 'cloud' });
    assert.equal(listed.artifacts.length, 0);
  } finally {
    await first.close();
  }
});

test('a Work objective can request a deliverable and the task result lists its stored files', async () => {
  const first = await startTestApp({
    gateway: fakeGateway({ text: 'Prepared the memo.' }),
    config: { persistence: { driver: 'mongo' } },
    persistence: { database: createFakeDatabase() },
  });
  try {
    const api = client(first.url);
    const accepted = await api.submitWork({
      objective: [
        'Write and store a short memo.',
        '```deliverable',
        JSON.stringify({
          kind: 'document',
          mode: 'cloud',
          filename: 'native-memo',
          title: 'Native Memo',
          blocks: [{ type: 'paragraph', text: 'Produced by a durable Work task.' }],
          formats: ['docx', 'markdown'],
        }),
        '```',
      ].join('\n'),
      mode: 'cloud',
      requireApproval: false,
    });
    const status = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });
    const files = (status.result?.artifacts ?? []).map((artifact) => artifact.path).sort();
    assert.deepEqual(files, ['native-memo.document.json', 'native-memo.docx', 'native-memo.md']);

    const listed = await api.artifacts({ mode: 'cloud', taskId: accepted.taskId });
    assert.equal(listed.artifacts.length, 3);
    assert.ok(listed.artifacts.every((artifact) => artifact.taskId === accepted.taskId));
  } finally {
    await first.close();
  }
});

test('a deliverable requires the owner token and validates its request', async () => {
  const first = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database: createFakeDatabase() },
  });
  try {
    const unauthenticated = new CoderaxClient({ baseUrl: first.url, token: 'wrong-token-value' });
    await assert.rejects(
      unauthenticated.deliver({
        kind: 'document',
        filename: 'x',
        title: 'X',
        blocks: [{ type: 'paragraph', text: 'Body.' }],
        formats: ['docx'],
      }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'unauthorized',
    );

    const api = client(first.url);
    await assert.rejects(
      api.deliver({
        kind: 'document',
        filename: '../escape',
        title: 'X',
        blocks: [{ type: 'paragraph', text: 'Body.' }],
        formats: ['docx'],
      }),
      (error: unknown) => error instanceof CoderaxApiError && error.code === 'validation_failed',
    );
  } finally {
    await first.close();
  }
});
