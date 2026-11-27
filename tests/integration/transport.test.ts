import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

/**
 * Transport ceilings.
 *
 * The contract carries an artifact as base64 with a declared maximum, so the
 * transport cannot apply one global bound: a contract-valid upload must reach
 * the handler, and a body past an operation's ceiling must be answered with a
 * structured 413. The over-limit cases are the regression this suite exists for —
 * an over-limit body used to destroy the socket, which reached the client as a
 * connection reset instead of a status it could read.
 */

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${OWNER_TOKEN}`, 'content-type': 'application/json' };
}

test('an over-limit artifact body receives a structured 413, not a reset', { timeout: 60_000 }, async () => {
  const started = await startTestApp();
  try {
    // The artifact ceiling is 16 MiB, so this is past it.
    const response = await fetch(`${started.url}/v1/artifacts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        path: 'large/oversized.bin',
        mediaType: 'application/octet-stream',
        contentBase64: 'A'.repeat(18_000_000),
      }),
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string; status: number };
    assert.equal(body.status, 413);
    assert.equal(body.code, 'payload_too_large');
  } finally {
    await started.close();
  }
});

test('a chunked over-limit body is drained and answered rather than reset', { timeout: 60_000 }, async () => {
  const started = await startTestApp();
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024, 0x43);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Five 4 MiB chunks: only the overflow is discovered while reading.
        if (sent >= 5) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await fetch(`${started.url}/v1/artifacts`, {
      method: 'POST',
      headers: authHeaders(),
      body: stream,
      // Required by fetch for a streaming request body, and absent from the DOM
      // type this project compiles against.
      ...({ duplex: 'half' } as Record<string, string>),
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'payload_too_large');
  } finally {
    await started.close();
  }
});

test('ordinary operations keep the small transport default', { timeout: 60_000 }, async () => {
  const started = await startTestApp();
  try {
    const response = await fetch(`${started.url}/v1/chat`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        message: 'x'.repeat(1_200_000),
        mode: 'cloud',
        agent: 'coderax',
      }),
    });
    assert.equal(response.status, 413);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, 'payload_too_large');
  } finally {
    await started.close();
  }
});
