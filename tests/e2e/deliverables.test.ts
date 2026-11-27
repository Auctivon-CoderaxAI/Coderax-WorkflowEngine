import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { createFakeDatabase } from '../fakes/mongo.js';
import { fakeGateway, OWNER_ID, OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';
import { createArtifactToolkit } from '../../src/artifacts/toolkit.js';
import { createDeliverableService } from '../../src/artifacts/deliver.js';
import type { ArtifactService } from '../../src/artifacts/service.js';

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
    const created = await api.generateDeliverable({
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
    const revised = await api.generateDeliverable({
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
      api.generateDeliverable({
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
      // `artifact` is the current descriptor; `version` is the one asked for.
      assert.equal(afterRestart.version.version, 2);
      assert.equal(afterRestart.version.sha256, revisedDocx.sha256);
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
    const dataset = await api.generateDeliverable({
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

    const software = await api.generateDeliverable({
      kind: 'software',
      mode: 'cloud',
      name: 'toolkit-demo',
      description: 'A small generated module.',
      template: 'module',
      language: 'javascript',
      files: [],
    });
    // The tree is reported by the store's own manifest, not by a second copy.
    const project = software.project;
    assert.ok(project, 'a generated project reports its stored tree');
    assert.ok(project.projectId.startsWith('proj_'));
    assert.equal(project.manifest.projectId, project.projectId);
    assert.equal(project.manifest.mode, 'cloud');
    assert.match(project.manifest.digest, /^[a-f0-9]{64}$/);
    assert.ok(project.manifest.files.length > 0);
    assert.equal(
      software.artifacts.length,
      project.manifest.files.length,
      'every stored file is described once, by the store',
    );
    assert.equal(
      software.artifacts.some((artifact) => artifact.filename.endsWith('.project.json')),
      false,
      'no manifest artifact is stored; the store derives it',
    );
    for (const file of project.manifest.files) {
      assert.ok(file.artifactId.startsWith('art_'));
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(file.relativePath.split('/').pop(), file.relativePath.split('/').at(-1));
      assert.ok(!file.relativePath.startsWith('/'));
      assert.ok(!file.relativePath.split('/').includes('..'));
      assert.equal(file.kind, 'software');
    }
    // The manifest is a query over the same rows, so both agree exactly.
    const listed = await api.artifactManifest(project.projectId, 'cloud');
    assert.deepEqual(
      listed.files.map((file) => [file.relativePath, file.artifactId, file.version]),
      project.manifest.files.map((file) => [file.relativePath, file.artifactId, file.version]),
    );
    assert.equal(listed.digest, project.manifest.digest);

    // A later generation can extend the same project; a path gains a version
    // instead of a second artifact.
    const extended = await api.generateDeliverable({
      kind: 'software',
      mode: 'cloud',
      name: 'toolkit-demo',
      description: 'The same project with a README.',
      template: 'module',
      language: 'javascript',
      files: [{ path: 'README.md', content: '# toolkit-demo\n' }],
      projectId: project.projectId,
    });
    assert.equal(extended.project?.projectId, project.projectId);
    const readme = project.manifest.files.find((file) => file.relativePath === 'README.md');
    const readmeAfter = extended.project?.manifest.files.find(
      (file) => file.relativePath === 'README.md',
    );
    assert.ok(readme && readmeAfter, 'the generated README is in both manifests');
    assert.equal(readmeAfter.artifactId, readme.artifactId, 'a path keeps its artifact identity');
    assert.equal(readmeAfter.version, readme.version + 1, 'changed bytes gain a version');
    assert.notEqual(readmeAfter.sha256, readme.sha256);

    // Regenerating an identical file is idempotent: the version does not move.
    const identical = project.manifest.files.find((file) => file.relativePath === 'src/index.js');
    const identicalAfter = extended.project?.manifest.files.find(
      (file) => file.relativePath === 'src/index.js',
    );
    assert.ok(identical && identicalAfter);
    assert.equal(identicalAfter.version, identical.version);
    assert.equal(identicalAfter.sha256, identical.sha256);
  } finally {
    await first.close();
  }
});

test('a software deliverable still reports that its program was never executed', async () => {
  const first = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database: createFakeDatabase() },
  });
  try {
    const api = client(first.url);
    const software = await api.generateDeliverable({
      kind: 'software',
      mode: 'cloud',
      name: 'never-run',
      description: 'A generated module whose verification stops at parsing.',
      template: 'module',
      language: 'javascript',
      files: [],
    });
    const project = software.project;
    assert.ok(project, 'the stored tree is reported');
    // The tree has no manifest file to carry this, so the result must.
    assert.equal(project.verification.executed, false, 'the program was never executed');
    assert.equal(project.verification.method, 'parse-and-resolve');
    assert.match(project.verification.note, /not executed/);
    assert.match(software.summary, /not executed/);
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
      api.generateDeliverable({
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
      unauthenticated.generateDeliverable({
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
      api.generateDeliverable({
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

test('an edit that fails after the output appends leaves the stored source on its old versions', async () => {
  const first = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database: createFakeDatabase() },
  });
  try {
    const api = client(first.url);
    const created = await api.generateDeliverable({
      kind: 'document',
      mode: 'cloud',
      filename: 'memo',
      title: 'Memo',
      blocks: BLOCKS,
      formats: ['docx', 'markdown'],
    });
    const sourceId = created.source!.artifactId;
    const docxId = created.artifacts.find((artifact) => artifact.filename === 'memo.docx')!.artifactId;
    const originalDocx = created.artifacts.find((artifact) => artifact.filename === 'memo.docx')!;
    const originalSource = JSON.parse(
      Buffer.from(
        (await api.downloadArtifact(sourceId, { mode: 'cloud' })).contentBase64,
        'base64',
      ).toString('utf8'),
    ) as { outputs: Array<{ format: string; artifactId: string; version: number }> };

    // The real durable service, with exactly one write refused: the source
    // version. The output appends before it go through untouched, which is the
    // interleaving this test is about.
    const dependencies = first.app.dependencies;
    const artifacts = Object.create(dependencies.artifactService) as ArtifactService;
    const append = dependencies.artifactService.addVersion.bind(dependencies.artifactService);
    artifacts.addVersion = async (principal, artifactId, request) => {
      if (artifactId === sourceId) {
        return {
          ok: false as const,
          code: 'storage_unavailable' as const,
          detail: 'injected: the source write failed after the outputs were appended',
          retryable: true,
        };
      }
      return append(principal, artifactId, request);
    };
    const service = createDeliverableService({
      toolkit: createArtifactToolkit(),
      artifacts,
      audit: dependencies.audit,
      clock: dependencies.clock,
      ids: dependencies.ids,
      roots: {
        private: dependencies.config.workspaces.privateRoot,
        cloud: dependencies.config.workspaces.cloudRoot,
      },
    });

    const failed = await service.deliver(
      { ownerId: OWNER_ID, isOwner: true },
      {
        kind: 'document',
        mode: 'cloud',
        filename: 'memo',
        title: 'Memo (revision that must not become visible)',
        edits: [
          { op: 'append', blocks: [{ type: 'paragraph', text: 'Written after the outputs were stored.' }] },
        ],
        formats: ['docx', 'markdown'],
        base: { artifactId: sourceId, mode: 'cloud', expectedVersion: 1 },
      },
    );
    if (failed.ok) throw new Error('the edit was expected to fail');
    assert.equal(failed.code, 'storage_unavailable', failed.detail);

    // The output really did get a new version before the failure...
    const docxNow = await api.downloadArtifact(docxId, { mode: 'cloud' });
    assert.equal(docxNow.version.version, 2);
    assert.notEqual(docxNow.version.sha256, originalDocx.sha256);
    assert.equal(
      Buffer.from(docxNow.contentBase64, 'base64').subarray(0, 2).toString(),
      'PK',
      'the appended version is a real DOCX, not a placeholder',
    );

    // ...while the stored source is still version 1 and still names the old
    // output versions, so nothing reads the orphaned append.
    const sourceNow = await api.downloadArtifact(sourceId, { mode: 'cloud' });
    assert.equal(sourceNow.version.version, 1);
    const sourceBody = JSON.parse(
      Buffer.from(sourceNow.contentBase64, 'base64').toString('utf8'),
    ) as { outputs: Array<{ format: string; artifactId: string; version: number }> };
    assert.deepEqual(
      sourceBody.outputs.map((output) => [output.format, output.version]).sort(),
      originalSource.outputs.map((output) => [output.format, output.version]).sort(),
    );

    // The failed edit created nothing and deleted nothing.
    const listed = await api.artifacts({ mode: 'cloud' });
    assert.equal(listed.artifacts.length, created.artifacts.length);
    for (const artifact of created.artifacts) {
      const current = listed.artifacts.find((entry) => entry.artifactId === artifact.artifactId);
      assert.ok(current, `${artifact.filename} still exists`);
    }

    // The pointer never moved, so the same expected version wins a retry.
    const retried = await api.generateDeliverable({
      kind: 'document',
      mode: 'cloud',
      filename: 'memo',
      title: 'Memo (retried)',
      edits: [
        { op: 'append', blocks: [{ type: 'paragraph', text: 'The retry after the failed write.' }] },
      ],
      formats: ['docx', 'markdown'],
      base: { artifactId: sourceId, mode: 'cloud', expectedVersion: 1 },
    });
    assert.equal(retried.source!.version, 2);
    const retriedSource = JSON.parse(
      Buffer.from(
        (await api.downloadArtifact(sourceId, { mode: 'cloud' })).contentBase64,
        'base64',
      ).toString('utf8'),
    ) as { outputs: Array<{ format: string; version: number }> };
    assert.ok(retriedSource.outputs.every((output) => output.version === 3));
  } finally {
    await first.close();
  }
});

test('two concurrent edits at the same expected version have one winner and one conflict', async () => {
  const first = await startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database: createFakeDatabase() },
  });
  try {
    const api = client(first.url);
    const created = await api.generateDeliverable({
      kind: 'document',
      mode: 'cloud',
      filename: 'race',
      title: 'Race',
      blocks: BLOCKS,
      formats: ['docx', 'markdown'],
    });
    const sourceId = created.source!.artifactId;
    const docxId = created.artifacts.find((artifact) => artifact.filename === 'race.docx')!.artifactId;

    const edit = (text: string) =>
      api.generateDeliverable({
        kind: 'document',
        mode: 'cloud',
        filename: 'race',
        title: `Race (${text})`,
        edits: [{ op: 'append', blocks: [{ type: 'paragraph', text }] }],
        formats: ['docx', 'markdown'],
        base: { artifactId: sourceId, mode: 'cloud', expectedVersion: 1 },
      });

    // Both readers saw version 1, so exactly one may append it.
    const settled = await Promise.allSettled([edit('Written by A.'), edit('Written by B.')]);
    const fulfilled = settled.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof edit>>> =>
        result.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    assert.equal(fulfilled.length, 1, 'exactly one edit wins');
    assert.equal(rejected.length, 1, 'exactly one edit is refused');

    const failure = rejected[0]!.reason;
    assert.ok(failure instanceof CoderaxApiError, 'the loser gets a typed refusal');
    assert.equal(failure.code, 'conflict');

    const winner = fulfilled[0]!.value;
    assert.equal(winner.source!.version, 2, 'the winner advanced the one source artifact');
    const storedSource = JSON.parse(
      Buffer.from(
        (await api.downloadArtifact(sourceId, { mode: 'cloud' })).contentBase64,
        'base64',
      ).toString('utf8'),
    ) as { outputs: Array<{ format: string; version: number }> };
    assert.ok(
      storedSource.outputs.every((output) => output.version === 2),
      'the stored source names the winner’s output versions',
    );

    // Both requests appended their outputs before either wrote the source; the
    // loser's version exists but is never named by the source, so no reader
    // resolves a half-applied edit.
    const history = await api.artifactVersions(docxId, 'cloud');
    assert.deepEqual(
      history.versions.map((version) => version.version),
      [1, 2, 3],
    );
    const winnerDocx = winner.artifacts.find((artifact) => artifact.filename === 'race.docx')!;
    assert.equal(winnerDocx.version, 2);
    assert.equal(history.versions[1]!.sha256, winnerDocx.sha256);
  } finally {
    await first.close();
  }
});
