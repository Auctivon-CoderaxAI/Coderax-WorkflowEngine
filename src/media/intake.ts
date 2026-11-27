import { createHash } from 'node:crypto';
import type { MediaAttachmentInput, MediaReference, MediaType } from '@coderax/contracts';
import { MEDIA_LIMITS } from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * Media intake is the only door an image may enter through.
 *
 * It never trusts the declared MIME type, the file name or the base64 string:
 * the format is identified from its own signature, the dimensions are read from
 * its header, animation is refused (a still image is what the model contract
 * promises), and every bound is enforced before a byte reaches the model. The
 * function is pure: it writes nothing, logs nothing and returns a value the
 * caller can persist or discard.
 */

export type ValidatedMedia = {
  reference: MediaReference;
  /** Canonical base64, carried only in memory and the stored turn's metadata. */
  dataBase64: string;
};

type Dimensions = {
  width: number;
  height: number;
  animated: boolean;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function uint24le(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function pngDimensions(bytes: Buffer): Dimensions | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let offset = 8;
  let dimensions: { width: number; height: number } | null = null;
  let animated = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (length > bytes.length - offset - 12) return null;
    if (type === 'IHDR') {
      if (length !== 13 || offset + 25 > bytes.length) return null;
      dimensions = {
        width: bytes.readUInt32BE(offset + 8),
        height: bytes.readUInt32BE(offset + 12),
      };
    } else if (type === 'acTL') {
      animated = true;
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    offset += 12 + length;
  }
  if (!dimensions || !ended) return null;
  return { ...dimensions, animated };
}

function jpegDimensions(bytes: Buffer): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) return null;
      if (bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) < 0) return null;
      return { width, height, animated: false };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(bytes: Buffer): Dimensions | null {
  if (bytes.length < 30) return null;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }
  const riffSize = bytes.readUInt32LE(4);
  if (riffSize + 8 > bytes.length) return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const flags = bytes[20]!;
    return {
      width: 1 + uint24le(bytes, 24),
      height: 1 + uint24le(bytes, 27),
      animated: (flags & 0x02) !== 0,
    };
  }
  if (chunk === 'VP8 ') {
    if (bytes.toString('hex', 23, 26) !== '9d012a') return null;
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      animated: false,
    };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      animated: false,
    };
  }
  return null;
}

/** The signature tells the truth; the declared `mediaType` only has to agree. */
function detect(bytes: Buffer, declared: MediaType): Dimensions | null {
  return declared === 'image/png'
    ? pngDimensions(bytes)
    : declared === 'image/jpeg'
      ? jpegDimensions(bytes)
      : webpDimensions(bytes);
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) return null;
  // Buffer.from is lenient about non-canonical tails; re-encoding proves the
  // caller sent the same bytes the engine will hash and route.
  if (bytes.toString('base64') !== value) return null;
  return bytes;
}

function safeLabel(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, ' ')
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}

function referenceFor(input: {
  mediaType: MediaType;
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
  name?: string;
  alt?: string;
}): MediaReference {
  return {
    mediaId: `media_${input.sha256.slice(0, 32)}`,
    kind: 'image',
    mediaType: input.mediaType,
    bytes: input.bytes.length,
    width: input.width,
    height: input.height,
    sha256: input.sha256,
    ...(input.name ? { name: input.name } : {}),
    ...(input.alt ? { alt: input.alt } : {}),
  };
}

/**
 * Validates a whole attachment set atomically. One bad item refuses the request
 * rather than dropping it silently: the caller never learns that half of its
 * images were ignored.
 */
export function intakeMedia(
  attachments: MediaAttachmentInput[] | undefined,
): ServiceResult<ValidatedMedia[]> {
  if (!attachments || attachments.length === 0) return ok([]);
  if (attachments.length > MEDIA_LIMITS.maxAttachments) {
    return fail(
      'validation_failed',
      `At most ${MEDIA_LIMITS.maxAttachments} images may be attached to one request.`,
    );
  }

  const accepted: ValidatedMedia[] = [];
  let totalBytes = 0;

  for (const attachment of attachments) {
    const bytes = decodeCanonicalBase64(attachment.dataBase64);
    if (!bytes) {
      return fail('validation_failed', 'Every attachment must be canonical base64 without a data: prefix.');
    }
    if (bytes.length > MEDIA_LIMITS.maxBytesPerAttachment) {
      return fail(
        'validation_failed',
        `Each image must be at most ${Math.floor(MEDIA_LIMITS.maxBytesPerAttachment / 1024)} KiB.`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MEDIA_LIMITS.maxTotalBytes) {
      return fail(
        'validation_failed',
        `Attachments must total at most ${Math.floor(MEDIA_LIMITS.maxTotalBytes / 1024)} KiB.`,
      );
    }

    const detected = detect(bytes, attachment.mediaType);
    if (!detected) {
      return fail(
        'validation_failed',
        'An attachment is not a well-formed image of its declared type.',
      );
    }
    if (detected.animated) {
      return fail('validation_failed', 'Animated images are not accepted; attach a still image.');
    }
    if (
      detected.width < 1 ||
      detected.height < 1 ||
      detected.width > MEDIA_LIMITS.maxDimension ||
      detected.height > MEDIA_LIMITS.maxDimension ||
      detected.width * detected.height > MEDIA_LIMITS.maxPixels
    ) {
      return fail(
        'validation_failed',
        `Images must be at most ${MEDIA_LIMITS.maxDimension} px on a side and ${MEDIA_LIMITS.maxPixels} pixels in total.`,
      );
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const name = safeLabel(attachment.name, MEDIA_LIMITS.maxNameChars);
    const alt = safeLabel(attachment.alt, MEDIA_LIMITS.maxAltChars);
    accepted.push({
      reference: referenceFor({
        mediaType: attachment.mediaType,
        bytes,
        width: detected.width,
        height: detected.height,
        sha256,
        ...(name ? { name } : {}),
        ...(alt ? { alt } : {}),
      }),
      dataBase64: attachment.dataBase64,
    });
  }

  return ok(accepted);
}

export function mediaDataUrl(media: { reference: MediaReference; dataBase64: string }): string {
  return `data:${media.reference.mediaType};base64,${media.dataBase64}`;
}
