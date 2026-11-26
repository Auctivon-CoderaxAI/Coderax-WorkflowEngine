import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderaxApiError, CoderaxClient } from '@coderax/sdk';
import { OWNER_TOKEN, startTestApp } from '../helpers.js';

/** A real 1x1 transparent PNG; the intake parses its IHDR dimensions. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function client(url: string): CoderaxClient {
  return new CoderaxClient({ baseUrl: url, token: OWNER_TOKEN });
}

test('the canonical media operation returns metadata for a validated image', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const result = await api.intakeMedia({
      attachments: [
        { kind: 'image', mediaType: 'image/png', dataBase64: PNG_1X1, name: 'pixel.png' },
      ],
    });
    assert.equal(result.media.length, 1);
    const media = result.media[0];
    assert.ok(media);
    assert.equal(media.mediaType, 'image/png');
    assert.equal(media.width, 1);
    assert.equal(media.height, 1);
    assert.equal(media.sha256.length, 64);
    assert.equal(media.bytes > 0, true);
    assert.equal(media.name, 'pixel.png');
    // The response is metadata only: the bytes are never echoed back.
    assert.equal(Object.hasOwn(media, 'dataBase64'), false);
  } finally {
    await started.close();
  }
});

test('media intake refuses a spoofed type, a data: prefix and an SVG payload', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const spoofed = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8').toString('base64');
    for (const dataBase64 of [`data:image/png;base64,${PNG_1X1}`, spoofed]) {
      await assert.rejects(
        api.intakeMedia({
          attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64 }],
        }),
        (error: unknown) => {
          assert.ok(error instanceof CoderaxApiError);
          assert.equal(error.code, 'validation_failed');
          return true;
        },
      );
    }
  } finally {
    await started.close();
  }
});

test('a validated image becomes part of a chat turn and its stored metadata', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const reply = await api.chat({
      message: 'What is in this image?',
      agent: 'coderax',
      mode: 'cloud',
      attachments: [
        { kind: 'image', mediaType: 'image/png', dataBase64: PNG_1X1, alt: 'one pixel' },
      ],
    });
    assert.equal(reply.text.length > 0, true);

    const conversation = await api.conversation(reply.conversationId);
    const userTurn = conversation.messages.find((message) => message.role === 'user');
    assert.ok(userTurn);
    assert.equal(userTurn.text, 'What is in this image?');
    assert.equal(userTurn.media?.length, 1);
    assert.equal(userTurn.media?.[0]?.mediaType, 'image/png');
    assert.equal(userTurn.media?.[0]?.width, 1);
    assert.equal(userTurn.media?.[0]?.alt, 'one pixel');
    // The transcript carries metadata, never the encoded bytes.
    assert.equal(JSON.stringify(conversation).includes(PNG_1X1), false);
  } finally {
    await started.close();
  }
});

test('a malformed attachment refuses the chat turn before any model call', async () => {
  const started = await startTestApp();
  const api = client(started.url);
  try {
    const spoofed = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8').toString('base64');
    await assert.rejects(
      api.chat({
        message: 'Describe this.',
        agent: 'coderax',
        mode: 'cloud',
        attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: spoofed }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof CoderaxApiError);
        assert.equal(error.code, 'validation_failed');
        return true;
      },
    );
  } finally {
    await started.close();
  }
});
