import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Deliverable, DeliverableRequest, ROUTE_INDEX, ROUTES } from '@coderax/contracts';

test('deliverable generation is one declared operation', () => {
  const route = ROUTE_INDEX.get('generateDeliverable');
  assert.ok(route, 'generateDeliverable is not declared');
  assert.equal(route.method, 'POST');
  assert.equal(route.path, '/v1/deliverables');
  assert.equal(route.auth, 'owner');

  // The interim artifact-tree generation operation is replaced, not duplicated:
  // two surfaces for one capability would drift.
  assert.equal(
    ROUTES.some((entry) => entry.path === '/v1/artifacts/generate'),
    false,
  );
});

test('the deliverable request and result are validated by the published schemas', () => {
  const request = DeliverableRequest.parse({
    kind: 'document',
    filename: 'quarterly-report',
    title: 'Quarterly report',
    blocks: [{ type: 'paragraph', text: 'Revenue grew in every region.' }],
    formats: ['docx', 'pdf'],
  });
  assert.equal(request.kind, 'document');

  // HTML is not a durable media type, so the contract itself refuses it.
  assert.equal(
    DeliverableRequest.safeParse({
      kind: 'document',
      filename: 'report',
      title: 'Report',
      formats: ['html'],
    }).success,
    false,
  );

  const artifact = {
    artifactId: 'art_1',
    kind: 'document',
    filename: 'quarterly-report.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: 1024,
    sha256: 'a'.repeat(64),
    mode: 'cloud',
    version: 1,
    versions: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    inferenceExposure: 'none',
  };
  const deliverable = Deliverable.parse({
    kind: 'document',
    title: 'Quarterly report',
    summary: 'A DOCX and its PDF.',
    artifacts: [artifact],
    verification: {
      ok: true,
      checks: [{ name: 'docx.structure', ok: true, detail: 'Read back 4 paragraphs.' }],
    },
    receipt: { receiptId: 'rcpt_1', at: '2026-01-01T00:00:00.000Z' },
  });
  assert.equal(deliverable.artifacts.length, 1);

  // The never-executed disclosure is mandatory on a generated project.
  const project = {
    projectId: 'proj_1',
    manifest: {
      projectId: 'proj_1',
      mode: 'cloud',
      files: [],
      digest: 'b'.repeat(64),
      generatedAt: '2026-01-01T00:00:00.000Z',
    },
    verification: { executed: false, method: 'parse-and-resolve', note: 'Not executed.' },
  };
  assert.equal(
    Deliverable.safeParse({
      kind: 'software',
      title: 'Tool',
      summary: 'A generated tree.',
      artifacts: [artifact],
      verification: {
        ok: true,
        checks: [{ name: 'imports.resolved', ok: true, detail: 'Every import resolves.' }],
      },
      receipt: { receiptId: 'rcpt_2', at: '2026-01-01T00:00:00.000Z' },
      project,
    }).success,
    true,
  );
  assert.equal(
    Deliverable.safeParse({
      kind: 'software',
      title: 'Tool',
      summary: 'A generated tree.',
      artifacts: [artifact],
      verification: {
        ok: true,
        checks: [{ name: 'imports.resolved', ok: true, detail: 'Every import resolves.' }],
      },
      receipt: { receiptId: 'rcpt_2', at: '2026-01-01T00:00:00.000Z' },
      project: { ...project, verification: { method: 'parse-and-resolve', note: 'Not executed.' } },
    }).success,
    false,
  );
});
