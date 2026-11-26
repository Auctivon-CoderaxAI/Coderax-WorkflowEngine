import type { MediaInspection } from '@coderax/contracts';

/**
 * Media capabilities are reported as they are, not as they are hoped to be.
 *
 * Image inspection is real and deterministic: it reads the container header and
 * reports format, byte size and pixel dimensions. Image generation/editing,
 * speech, audio and video understanding require a verified zero-cost model, and
 * this engine has none configured; those capabilities are therefore unavailable
 * with a reason, rather than a simulated result or a paid route.
 */

export function inspectImage(buffer: Buffer): MediaInspection {
  if (buffer.length < 24) {
    throw new RangeError('The image is too small to contain a header.');
  }

  if (
    buffer[0] === 0x89 &&
    buffer.toString('latin1', 1, 4) === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    if (buffer.toString('latin1', 12, 16) !== 'IHDR') {
      throw new RangeError('The PNG header does not contain an IHDR chunk.');
    }
    return {
      mediaType: 'image/png',
      format: 'png',
      bytes: buffer.length,
      dimensions: { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) },
      method: 'header',
    };
  }

  const gif = buffer.toString('latin1', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    return {
      mediaType: 'image/gif',
      format: 'gif',
      bytes: buffer.length,
      dimensions: { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) },
      method: 'header',
    };
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      const isStartOfFrame =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isStartOfFrame) {
        return {
          mediaType: 'image/jpeg',
          format: 'jpeg',
          bytes: buffer.length,
          dimensions: {
            width: buffer.readUInt16BE(offset + 7),
            height: buffer.readUInt16BE(offset + 5),
          },
          method: 'header',
        };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    throw new RangeError('The JPEG has no readable frame header.');
  }

  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return {
        mediaType: 'image/webp',
        format: 'webp',
        bytes: buffer.length,
        dimensions: { width, height },
        method: 'header',
      };
    }
    if (chunk === 'VP8 ') {
      return {
        mediaType: 'image/webp',
        format: 'webp',
        bytes: buffer.length,
        dimensions: {
          width: buffer.readUInt16LE(26) & 0x3fff,
          height: buffer.readUInt16LE(28) & 0x3fff,
        },
        method: 'header',
      };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const b1 = buffer[21] ?? 0;
      const b2 = buffer[22] ?? 0;
      const b3 = buffer[23] ?? 0;
      const b4 = buffer[24] ?? 0;
      return {
        mediaType: 'image/webp',
        format: 'webp',
        bytes: buffer.length,
        dimensions: {
          width: 1 + (((b2 & 0x3f) << 8) | b1),
          height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
        },
        method: 'header',
      };
    }
    throw new RangeError('The WebP container has an unsupported chunk layout.');
  }

  throw new RangeError('The media type is not one this engine can inspect (PNG, JPEG, GIF or WebP).');
}

