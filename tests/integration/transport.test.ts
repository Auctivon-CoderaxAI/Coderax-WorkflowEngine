import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARTIFACT_MAX_BYTES } from '@coderax/contracts';
import { CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, startTestApp, waitFor } from '../helpers.js';

/**
 * Transport limits.
 *
 * The contract carries an artifact as base64 with a declared maximum, so the
 * transport cannot apply one global body bound: a contract-valid maximum upload
 * must reach the handler, and a body past the declared bound must be answered
 * with a structured 413. The second case is the regression this suite exists for
 * — an over-limit body used to destroy the socket, which reached the client as
 * ECONNRESET instead of a status it could read.
 */

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

async function completedTask(api: CoderaxClient): Promise<string> {
  const accepted = await api.submitWork({
    objective: 'Transport limit work',
    mode: 'cloud',
    agent: 'coderax',
    requireApproval: true,
  });
  await waitFor(async () => {
    const current = await api.task(accepted.taskId);
    return current.state === 'completed' ? current : null;
  });
  return accepted.taskId;
}

test('a contract-maximum artifact uploads, persists and round-trips', { timeout: 120_000 }, async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const taskId = await completedTask(api);
    // Exactly the largest artifact the contract can encode. This body is far
    // above the ordinary 1 MiB request bound, which is the point.
    const content = Buffer.alloc(ARTIFACT_MAX_BYTES, 0x41);
    const record = await api.uploadArtifact(taskId, {
      path: 'large/maximum.bin',
      mediaType: 'application/octet-stream',
      contentBase64: content.toString('base64'),
    });
    assert.equal(record.bytes, ARTIFACT_MAX_BYTES);
    assert.match(record.digest, /^sha256:[0-9a-f]{64}$/);

    const listed = await api.artifacts(taskId);
    assert.equal(listed.artifacts.length, 1);
    const stored = await api.artifactContent(record.artifactId);
    assert.equal(stored.bytes, ARTIFACT_MAX_BYTES);
    assert.equal(stored.digest, record.digest);
  } finally {
    await started.close();
  }
});

test('one byte past the contract bound is refused before it reaches storage', { timeout: 120_000 }, async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const taskId = await completedTask(api);
    const content = Buffer.alloc(ARTIFACT_MAX_BYTES + 1, 0x42);
    await assert.rejects(
      api.uploadArtifact(taskId, {
        path: 'large/too-big.bin',
        mediaType: 'application/octet-stream',
        contentBase64: content.toString('base64'),
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'validation_failed');
        return true;
      },
    );
    const listed = await api.artifacts(taskId);
    assert.equal(listed.artifacts.length, 0);
  } finally {
    await started.close();
  }
});

test('an over-limit artifact body receives a structured 413, not a reset', { timeout: 120_000 }, async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const taskId = await completedTask(api);
    const oversized = 'A'.repeat(12_100_000);
    // A reset would reject this promise; the contract promises a readable status.
    const response = await fetch(`${started.url}/v1/work/${taskId}/artifacts`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        path: 'large/oversized.bin',
        mediaType: 'application/octet-stream',
        contentBase64: oversized,
      }),
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string; status: number };
    assert.equal(body.status, 413);
    assert.equal(body.code, 'validation_failed');
  } finally {
    await started.close();
  }
});

test('a chunked over-limit body is drained and answered rather than reset', { timeout: 120_000 }, async () => {
  const started = await startTestApp();
  try {
    const api = client(started.url);
    const taskId = await completedTask(api);
    const chunk = Buffer.alloc(4 * 1024 * 1024, 0x43);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 4) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await fetch(`${started.url}/v1/work/${taskId}/artifacts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' },
      // No content-length: the server only discovers the overflow while reading.
      body: stream,
      // Required by fetch for a streaming request body, and absent from the DOM
      // type this project compiles against.
      ...({ duplex: 'half' } as Record<string, string>),
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'validation_failed');
  } finally {
    await started.close();
  }
});

test('ordinary operations keep the small body bound', { timeout: 60_000 }, async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'x'.repeat(1_200_000),
        mode: 'cloud',
        agent: 'coderax',
      }),
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'validation_failed');
  } finally {
    await started.close();
  }
});
