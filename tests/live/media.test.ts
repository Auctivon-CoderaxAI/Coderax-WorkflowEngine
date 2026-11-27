import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createOpenAiCompatibleGateway } from '../../src/agents/native/gateway.js';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

/**
 * Live media boundary.
 *
 * The unit suite validates image headers in isolation and the e2e suite proves
 * the intake route. This suite opens a real socket to an OpenAI-compatible
 * endpoint and sends a turn that carries an image, so the vision route, the
 * provider transport and the media intake are exercised together rather than
 * against a stubbed gateway.
 */

/** A real 1x1 transparent PNG; the intake parses its IHDR dimensions. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function startProvider(): Promise<{
  url: string;
  bodies: Array<Record<string, unknown>>;
  close: () => Promise<void>;
}> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'live-media',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'The image was received.' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('an image turn crosses a real provider socket and the bytes are not echoed', async () => {
  const provider = await startProvider();
  const started = await startTestApp({
    gateway: createOpenAiCompatibleGateway({ baseURL: `${provider.url}/v1`, apiKey: 'live-key' }),
    config: { models: { vision: [{ providerId: 'free', modelId: 'coderax-small' }] } },
  });
  try {
    const response = await fetch(`${started.url}/v1/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: 'Describe the attached image.',
        mode: 'cloud',
        attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1X1 }],
      }),
    });
    assert.equal(response.status, 200);
    const reply = (await response.json()) as { text: string };
    assert.equal(reply.text, 'The image was received.');

    assert.equal(provider.bodies.length, 1);
    // The provider receives the image as an image part, not as prompt text.
    const sent = JSON.stringify(provider.bodies[0]);
    assert.match(sent, /image_url/);
    assert.match(sent, /data:image\/png;base64/);
  } finally {
    await started.close();
    await provider.close();
  }
});
