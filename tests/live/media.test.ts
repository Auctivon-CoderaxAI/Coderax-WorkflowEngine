import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderCompletionRequest } from '../../src/models/types.js';
import { OWNER_TOKEN, fakeProvider, startTestApp } from '../helpers.js';

/**
 * Live media boundary.
 *
 * The unit suite validates image headers in isolation. This suite sends a real
 * PNG through the engine's HTTP socket and then lets the composed engine drive a
 * vision turn, recording exactly what a provider would receive, so an intake
 * that only works against in-process values cannot pass.
 */

/** A real 1x1 transparent PNG; the intake parses its IHDR dimensions. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a real PNG crosses the HTTP boundary and reaches the provider as an image part', async () => {
  const requests: ProviderCompletionRequest[] = [];

  const fixture = fakeProvider({
    text: 'The image was received.',
    vision: true,
  });

  const provider = {
    ...fixture,
    complete: async (request: ProviderCompletionRequest) => {
      requests.push(request);
      return fixture.complete(request);
    },
  };

  const started = await startTestApp({ provider });
  try {
    const accepted = await fetch(`${started.url}/v1/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${OWNER_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1X1 }],
      }),
    });
    assert.equal(accepted.status, 200);
    const intake = (await accepted.json()) as {
      media: Array<{ width: number; height: number; sha256: string }>;
    };
    assert.equal(intake.media.length, 1);
    assert.equal(intake.media[0]?.width, 1);
    assert.equal(intake.media[0]?.height, 1);
    assert.equal(intake.media[0]?.sha256.length, 64);

    const turn = await fetch(`${started.url}/v1/chat`, {
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
    assert.equal(turn.status, 200);
    const reply = (await turn.json()) as { text: string };
    assert.equal(reply.text, 'The image was received.');
    assert.equal(requests.length, 1);
    const images = requests.flatMap((request) =>
      (request.messages ?? []).flatMap((message) => message.images ?? []),
    );

    assert.equal(images.length, 1);
    assert.match(images[0] ?? '', /^data:image\/png;base64,/);
    assert.equal(images[0], `data:image/png;base64,${PNG_1X1}`);
  } finally {
    await started.close();
  }
});
