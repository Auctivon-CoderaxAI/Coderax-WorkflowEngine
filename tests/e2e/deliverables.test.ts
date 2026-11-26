import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { CoderaxClient } from '@coderax/sdk';
import { createFakeDatabase } from '../fakes/mongo.js';
import { OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

/**
 * Deliverables are only successful when the durable service stored them, so the
 * suite runs on the fake MongoDB driver and selects mongo persistence.
 */
function startDurable() {
  return startTestApp({
    config: { persistence: { driver: 'mongo' } },
    persistence: { database: createFakeDatabase() },
  });
}

test('a document is produced through the API and its recorded digest matches the file', async () => {
  const started = await startDurable();
  const api = client(started.url);
  try {
    const capabilities = await api.capabilities();
    assert.equal(
      capabilities.capabilities.find((entry) => entry.name === 'image.generation')?.state,
      'unavailable',
    );
    assert.equal(
      capabilities.capabilities.find((entry) => entry.name === 'spreadsheet.intelligence')
        ?.state,
      'available',
    );

    const deliverable = await api.deliver({
      kind: 'document',
      mode: 'cloud',
      filename: 'api-document',
      title: 'API document',
      formats: ['docx', 'pdf'],
      blocks: [
        { type: 'heading', level: 1, text: 'Summary' },
        { type: 'paragraph', text: 'Produced through the published contract and verified after writing.' },
      ],
    });
    assert.equal(deliverable.verification.ok, true);
    assert.equal(deliverable.receipt.receiptId.length > 0, true);

    const docx = deliverable.artifacts.find((artifact) => artifact.filename.endsWith('.docx'));
    assert.ok(docx);
    const stored = await api.downloadArtifact(docx.artifactId, { mode: 'cloud' });
    const digest = createHash('sha256')
      .update(Buffer.from(stored.contentBase64, 'base64'))
      .digest('hex');
    assert.equal(docx.sha256, digest);
    assert.equal(docx.inferenceExposure, 'none');
    assert.equal(docx.bytes > 0, true);
  } finally {
    await started.close();
  }
});

test('a workbook is produced through the API with a verified chart part', async () => {
  const started = await startDurable();
  const api = client(started.url);
  try {
    const deliverable = await api.deliver({
      kind: 'spreadsheet',
      mode: 'cloud',
      filename: 'api-workbook',
      title: 'API workbook',
      sheets: [
        {
          name: 'Data',
          columns: [
            { header: 'Label', type: 'text', total: false },
            { header: 'Value', type: 'number', total: true },
          ],
          rows: [
            ['A', 1],
            ['B', 2],
          ],
          formulas: [],
          table: true,
          charts: [
            {
              type: 'bar',
              title: 'Values',
              categories: ['A', 'B'],
              series: [{ name: 'Value', values: [1, 2] }],
            },
          ],
          freezeHeader: true,
        },
      ],
    });
    assert.equal(deliverable.verification.ok, true);
    const xlsx = deliverable.artifacts.find((artifact) => artifact.filename.endsWith('.xlsx'));
    assert.ok(xlsx);
    assert.equal(xlsx.kind, 'spreadsheet');
    assert.equal(xlsx.version, 1);
  } finally {
    await started.close();
  }
});

test('a Work objective can declare a deliverable that Native produces and records', async () => {
  const started = await startDurable();
  const api = client(started.url);
  try {
    const directive = JSON.stringify({
      kind: 'document',
      mode: 'cloud',
      filename: 'release-note',
      title: 'Release note',
      formats: ['docx'],
      blocks: [{ type: 'paragraph', text: 'Native produced this deliverable from a Work objective.' }],
    });
    const objective = `Prepare the release note.\n\n\`\`\`deliverable\n${directive}\n\`\`\``;
    const accepted = await api.submitWork({
      objective,
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });

    const status = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'completed' ? current : null;
    });
    const docx = status.result?.artifacts.find((artifact) => artifact.path.endsWith('.docx'));
    assert.ok(docx, 'the task result must carry the produced artifact');
    assert.ok(docx.artifactId, 'the task artifact must reference durable storage');

    const agents = await api.agents();
    const native = agents.agents.find((agent) => agent.id === 'coderax');
    assert.equal(native?.capabilities.tools, true);
  } finally {
    await started.close();
  }
});

test('an unparseable deliverable directive fails the task instead of being ignored', async () => {
  const started = await startDurable();
  const api = client(started.url);
  try {
    const objective = 'Prepare a document.\n\n```deliverable\nnot json at all\n```';
    const accepted = await api.submitWork({
      objective,
      agent: 'coderax',
      mode: 'cloud',
      requireApproval: true,
    });
    const failed = await waitFor(async () => {
      const current = await api.task(accepted.taskId);
      return current.state === 'failed' ? current : null;
    });
    assert.equal(failed.failure?.code, 'validation_failed');
    assert.match(failed.failure?.detail ?? '', /not valid JSON/i);
  } finally {
    await started.close();
  }
});
