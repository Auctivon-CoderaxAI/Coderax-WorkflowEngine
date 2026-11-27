import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeAgent } from '../../src/agents/native/agent.js';
import { intakeMedia } from '../../src/media/intake.js';
import { chunk, jpeg, png, webp } from '../fixtures/media.js';

function attachment(
  bytes: Buffer,
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp',
  name?: string,
) {
  return {
    kind: 'image' as const,
    mediaType,
    dataBase64: bytes.toString('base64'),
    ...(name ? { name } : {}),
  };
}

test('a well-formed PNG is accepted with its real dimensions and digest', () => {
  const result = intakeMedia([attachment(png(7, 9), 'image/png', '../report.png')]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [media] = result.value;
  assert.ok(media);
  assert.equal(media.reference.mediaType, 'image/png');
  assert.equal(media.reference.width, 7);
  assert.equal(media.reference.height, 9);
  assert.equal(media.reference.bytes, png(7, 9).length);
  assert.equal(media.reference.sha256.length, 64);
  assert.ok(media.reference.mediaId.startsWith('media_'));
  // A display name is never treated as a path.
  assert.equal(media.reference.name?.includes('/'), false);
  assert.equal(media.reference.name?.includes('\\'), false);
});

test('JPEG and WebP are identified from their own headers', () => {
  const jpegResult = intakeMedia([attachment(jpeg(11, 13), 'image/jpeg')]);
  assert.equal(jpegResult.ok, true);
  if (jpegResult.ok) {
    assert.equal(jpegResult.value[0]?.reference.width, 11);
    assert.equal(jpegResult.value[0]?.reference.height, 13);
  }

  const webpResult = intakeMedia([attachment(webp(16, 10), 'image/webp')]);
  assert.equal(webpResult.ok, true);
  if (webpResult.ok) {
    assert.equal(webpResult.value[0]?.reference.width, 16);
    assert.equal(webpResult.value[0]?.reference.height, 10);
  }
});

test('the declared type must match the magic bytes', () => {
  const disguised = intakeMedia([attachment(png(), 'image/jpeg')]);
  assert.equal(disguised.ok, false);
  assert.match(disguised.ok === false ? disguised.detail : '', /well-formed/);
});

test('SVG, GIF and archive bytes are refused even when declared as a raster type', () => {
  for (const bytes of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    Buffer.from('GIF89a\x01\x00\x01\x00', 'binary'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
  ]) {
    const result = intakeMedia([attachment(bytes, 'image/png')]);
    assert.equal(result.ok, false);
  }
});

test('animated PNG and WebP are refused', () => {
  const actl = chunk('acTL', Buffer.alloc(8));
  const animatedPng = intakeMedia([attachment(png(2, 2, [actl]), 'image/png')]);
  assert.equal(animatedPng.ok, false);
  assert.match(animatedPng.ok === false ? animatedPng.detail : '', /Animated/);

  const animatedWebp = intakeMedia([attachment(webp(4, 4, true), 'image/webp')]);
  assert.equal(animatedWebp.ok, false);
  assert.match(animatedWebp.ok === false ? animatedWebp.detail : '', /Animated/);
});

test('pixel-bomb dimensions are refused from the header alone', () => {
  const huge = intakeMedia([attachment(png(9000, 20), 'image/png')]);
  assert.equal(huge.ok, false);
  assert.match(huge.ok === false ? huge.detail : '', /8192|pixels/);
});

test('per-item, total and count limits are enforced', () => {
  const oversized = Buffer.concat([png(), Buffer.alloc(2 * 1024 * 1024)]);
  const item = intakeMedia([attachment(oversized, 'image/png')]);
  assert.equal(item.ok, false);
  assert.match(item.ok === false ? item.detail : '', /at most/);

  const padded = (size: number): Buffer => png(2, 2, [chunk('tEXt', Buffer.alloc(size, 0x41))]);
  const total = intakeMedia([
    attachment(padded(1_500_000), 'image/png'),
    attachment(padded(1_500_000), 'image/png'),
    attachment(padded(1_500_000), 'image/png'),
  ]);
  assert.equal(total.ok, false);
  assert.match(total.ok === false ? total.detail : '', /total at most/);

  const tooMany = intakeMedia(Array.from({ length: 5 }, () => attachment(png(), 'image/png')));
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.ok === false ? tooMany.detail : '', /At most 4/);
});

test('non-canonical base64 and a missing image body are refused', () => {
  const padded = intakeMedia([{ kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }]);
  assert.equal(padded.ok, false);
  const nonCanonical = intakeMedia([
    { kind: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
  ]);
  assert.equal(nonCanonical.ok, false);
});

test('a truncated JPEG without a frame header is refused', () => {
  const truncated = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00]),
  ]);
  const result = intakeMedia([attachment(truncated, 'image/jpeg')]);
  assert.equal(result.ok, false);
});

test('Native sends a validated image as content parts on the chat model call', async () => {
  const model = { providerId: 'fixture', modelId: 'fixture' };
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  let capturedImages: string[] | undefined;
  const native = createNativeAgent({
    enabled: true,
    gateway: {
      id: 'fixture',
      complete: async (request) => {
        capturedImages = request.images;
        return { text: 'seen', usage: {} };
      },
    },
  });
  const outcome = await native.run(
    {
      ownerId: 'owner',
      tenantId: null,
      conversationId: 'conv',
      workload: 'work',
      game: null,
      objective: 'describe the attached image',
      model,
      mode: 'cloud',
      workspaceRoot: '/fixture',
      maxSteps: 1,
      budget: null,
      signal: new AbortController().signal,
      media: [
        {
          reference: {
            mediaId: 'media_1',
            kind: 'image',
            mediaType: 'image/png',
            bytes: 8,
            width: 1,
            height: 1,
            sha256: '0'.repeat(64),
          },
          dataUrl,
        },
      ],
    },
    () => undefined,
  );
  assert.equal(outcome.ok, true);
  assert.deepEqual(capturedImages, [dataUrl]);
});
