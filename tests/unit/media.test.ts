import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../../src/support/clock.js';
import { decodeBase64 } from '../../src/media/decode.js';
import { sniffImage } from '../../src/media/sniff.js';
import { createMediaService } from '../../src/media/service.js';
import { createMediaStore } from '../../src/media/store.js';
import { gifBytes, jpegBytes, pngBytes, webpBytes } from '../helpers.js';

const LIMITS = { maxPixels: 40_000_000 };

test('PNG, JPEG, WebP and single-frame GIF are identified from their headers', () => {
  const png = sniffImage(pngBytes(320, 200), LIMITS);
  assert.deepEqual(png, { ok: true, mediaType: 'image/png', width: 320, height: 200 });

  const jpeg = sniffImage(jpegBytes(640, 480), LIMITS);
  assert.deepEqual(jpeg, { ok: true, mediaType: 'image/jpeg', width: 640, height: 480 });

  const webp = sniffImage(webpBytes(800, 600), LIMITS);
  assert.deepEqual(webp, { ok: true, mediaType: 'image/webp', width: 800, height: 600 });

  const gif = sniffImage(gifBytes(64, 32), LIMITS);
  assert.deepEqual(gif, { ok: true, mediaType: 'image/gif', width: 64, height: 32 });
});

test('a pixel ceiling is enforced from the header without decompression', () => {
  const result = sniffImage(pngBytes(10_000, 10_000), { maxPixels: 1_000_000 });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'media_invalid');
  assert.match(result.ok === false ? result.detail : '', /pixel limit/);
});

test('animated images are refused rather than sampled silently', () => {
  const gif = sniffImage(gifBytes(8, 8, 2), LIMITS);
  assert.equal(gif.ok, false);
  assert.equal(gif.ok === false && gif.code, 'media_unsupported');

  const animated = webpBytes(8, 8);
  animated[20] = 0x02;
  const webp = sniffImage(animated, LIMITS);
  assert.equal(webp.ok, false);
  assert.equal(webp.ok === false && webp.code, 'media_unsupported');
});

test('active and unsupported formats never become image input', () => {
  for (const content of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<?xml version="1.0"?><svg/>',
    '<!doctype html><html><body>hi</body></html>',
    '%PDF-1.7 leading bytes',
  ]) {
    const result = sniffImage(Buffer.from(content, 'utf8'), LIMITS);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'media_unsupported');
  }
});

test('a truncated or inconsistent header is invalid, not guessed', () => {
  const png = pngBytes(4, 4).subarray(0, 20);
  assert.equal(sniffImage(png, LIMITS).ok, false);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x40, 0x08]);
  assert.equal(sniffImage(jpeg, LIMITS).ok, false);

  const unknown = Buffer.from('not an image at all');
  const result = sniffImage(unknown, LIMITS);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, 'media_unsupported');
});

test('base64 decoding is canonical and bounded before allocation', () => {
  const bytes = pngBytes(2, 2);
  const canonical = bytes.toString('base64');
  assert.deepEqual(decodeBase64(canonical, 1_000), { ok: true, bytes });

  for (const bad of [
    `${canonical}\n`,
    canonical.slice(0, -1),
    `${canonical.slice(0, -2)}-_`,
    'A',
    Buffer.from([1, 2]).toString('base64').replace(/=$/, ''),
  ]) {
    const result = decodeBase64(bad, 1_000);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, 'media_invalid');
  }

  const huge = Buffer.alloc(2_000, 1).toString('base64');
  const oversized = decodeBase64(huge, 1_024);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.ok === false && oversized.code, 'media_too_large');
});

test('an upload is owner-scoped, header-typed and mode-bound', async () => {
  const media = createMediaService({
    store: createMediaStore(),
    clock: createClock(),
    limits: {
      enabled: true,
      maxBytes: 5_000_000,
      maxPixels: 40_000_000,
      maxAttachments: 4,
      creativeMaxBytes: 262_144,
      allowPrivateModeAttachments: false,
    },
  });
  const data = pngBytes(10, 10).toString('base64');

  const uploaded = await media.upload('owner-a', {
    mode: 'cloud',
    data,
    declaredType: 'image/png',
  });
  assert.equal(uploaded.ok, true);
  if (!uploaded.ok) return;
  assert.equal(uploaded.value.media.mediaType, 'image/png');

  const mismatch = await media.upload('owner-a', {
    mode: 'cloud',
    data,
    declaredType: 'image/jpeg',
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.ok === false && mismatch.code, 'media_invalid');

  const foreign = await media.get('owner-b', uploaded.value.media.mediaId);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.code, 'not_found');

  const wrongMode = await media.resolve({
    ownerId: 'owner-a',
    mode: 'private',
    mediaIds: [uploaded.value.media.mediaId],
  });
  assert.equal(wrongMode.ok, false);
  assert.equal(wrongMode.ok === false && wrongMode.code, 'forbidden');

  const resolved = await media.resolve({
    ownerId: 'owner-a',
    mode: 'cloud',
    mediaIds: [uploaded.value.media.mediaId],
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.match(resolved.value[0]?.dataUrl ?? '', /^data:image\/png;base64,/);
  }
});

test('the capability report keeps unimplemented modalities unavailable', () => {
  const media = createMediaService({
    store: createMediaStore(),
    clock: createClock(),
    limits: {
      enabled: true,
      maxBytes: 4_194_304,
      maxPixels: 40_000_000,
      maxAttachments: 4,
      creativeMaxBytes: 262_144,
      allowPrivateModeAttachments: false,
    },
  });
  const unavailable = media.capabilities({ available: false, detail: 'No vision route.' });
  assert.equal(unavailable.inputs.find((entry) => entry.kind === 'image')?.available, false);
  for (const kind of ['audio', 'video', 'document'] as const) {
    const entry = unavailable.inputs.find((item) => item.kind === kind);
    assert.equal(entry?.available, false);
    assert.match(entry?.reason.detail ?? '', /not implemented/);
  }
  assert.deepEqual(unavailable.creative.formats, ['svg', 'html']);
  assert.equal(unavailable.creative.scripts, false);
  assert.equal(unavailable.creative.externalResources, false);
  assert.equal(unavailable.creative.sandbox, 'required');
  assert.equal(unavailable.privateModeAttachments.available, false);
});
