/**
 * Transport decoding for media bytes.
 *
 * The HTTP body is JSON, so an image arrives as base64. Decoding is strict:
 * whitespace, URL-safe alphabets, misplaced padding and non-canonical encodings
 * are refused instead of repaired. The encoded length is checked before the
 * buffer is allocated, so an oversized request never becomes an oversized
 * allocation. The file itself is never decompressed here.
 */
export type DecodeFailure = {
  ok: false;
  code: 'media_invalid' | 'media_too_large';
  detail: string;
};

export type DecodeResult = { ok: true; bytes: Buffer } | DecodeFailure;

export function decodeBase64(input: string, maxBytes: number): DecodeResult {
  if (input.length === 0) {
    return { ok: false, code: 'media_invalid', detail: 'The media payload is empty.' };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input) || input.length % 4 !== 0) {
    return {
      ok: false,
      code: 'media_invalid',
      detail: 'The media payload is not canonical base64.',
    };
  }

  const padding = input.endsWith('==') ? 2 : input.endsWith('=') ? 1 : 0;
  const estimated = (input.length / 4) * 3 - padding;
  if (estimated > maxBytes) {
    return {
      ok: false,
      code: 'media_too_large',
      detail: `The decoded media would exceed the ${maxBytes}-byte limit.`,
    };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(input, 'base64');
  } catch {
    return { ok: false, code: 'media_invalid', detail: 'The media payload could not be decoded.' };
  }
  if (bytes.length === 0 || bytes.toString('base64') !== input) {
    return {
      ok: false,
      code: 'media_invalid',
      detail: 'The media payload is not canonical base64.',
    };
  }
  if (bytes.length > maxBytes) {
    return {
      ok: false,
      code: 'media_too_large',
      detail: `The decoded media exceeds the ${maxBytes}-byte limit.`,
    };
  }
  return { ok: true, bytes };
}
