import type { ImageMediaType } from '@coderax/contracts';

/**
 * Format identification from the file's own header.
 *
 * Nothing is decompressed: the sniffer reads the PNG IHDR, the JPEG SOF segment,
 * the GIF logical screen descriptor and the WebP chunk headers. That means a
 * submitted image cannot expand on this process, and the pixel ceiling is
 * enforced before any downstream decoder sees it. Anything the sniffer does not
 * recognise is refused, including SVG and HTML, which can carry active content.
 */

export type SniffFailure = {
  ok: false;
  code: 'media_invalid' | 'media_unsupported';
  detail: string;
};

export type SniffResult =
  | { ok: true; mediaType: ImageMediaType; width: number; height: number }
  | SniffFailure;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function invalid(detail: string): SniffFailure {
  return { ok: false, code: 'media_invalid', detail };
}

function unsupported(detail: string): SniffFailure {
  return { ok: false, code: 'media_unsupported', detail };
}

function withinPixelBound(
  width: number,
  height: number,
  maxPixels: number,
): SniffFailure | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return invalid('The image header reports an invalid size.');
  }
  if (width > 65_535 || height > 65_535) {
    return invalid('The image header reports a dimension above the supported maximum.');
  }
  if (width * height > maxPixels) {
    return invalid(
      `The image is ${width}x${height}, above the ${maxPixels}-pixel limit.`,
    );
  }
  return null;
}

function sniffPng(bytes: Buffer, maxPixels: number): SniffResult {
  if (bytes.length < 33) return invalid('The PNG header is truncated.');
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    return invalid('The PNG does not begin with an IHDR chunk.');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bound = withinPixelBound(width, height, maxPixels);
  if (bound) return bound;
  const bitDepth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  if (
    ![1, 2, 4, 8, 16].includes(bitDepth) ||
    ![0, 2, 3, 4, 6].includes(colorType) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    (bytes[28] !== 0 && bytes[28] !== 1)
  ) {
    return invalid('The PNG IHDR fields are not a supported image encoding.');
  }
  // Walk the chunk stream without inflating it. This rejects a file that ends
  // after IHDR, and an APNG is refused because its animation frames are not a
  // still image even though the first frame would decode.
  let offset = 33;
  let chunks = 0;
  let sawData = false;
  let ended = false;
  let animated = false;
  while (offset + 12 <= bytes.length) {
    chunks += 1;
    if (chunks > 4_096) return invalid('The PNG has too many chunks to verify safely.');
    const length = bytes.readUInt32BE(offset);
    if (length > 0x7fffffff || offset + 12 + length > bytes.length) {
      return invalid('The PNG chunk length is inconsistent with the file.');
    }
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') animated = true;
    if (type === 'IDAT') sawData = true;
    offset += 12 + length;
    if (type === 'IEND') {
      if (length !== 0) return invalid('The PNG IEND chunk is malformed.');
      ended = true;
      break;
    }
  }
  if (!ended) return invalid('The PNG is truncated: it has no IEND chunk.');
  if (!sawData) return invalid('The PNG has no image data.');
  if (animated) return unsupported('Animated PNG is not accepted; attach a still image.');
  return { ok: true, mediaType: 'image/png', width, height };
}

function sniffJpeg(bytes: Buffer, maxPixels: number): SniffResult {
  let offset = 2;
  let width = 0;
  let height = 0;
  let segments = 0;
  while (offset + 3 < bytes.length) {
    segments += 1;
    if (segments > 4_096) return invalid('The JPEG has too many segments to verify safely.');
    if (bytes[offset] !== 0xff) return invalid('The JPEG segment stream is malformed.');
    let marker = bytes[offset + 1] ?? 0;
    offset += 2;
    while (marker === 0xff) {
      marker = bytes[offset] ?? 0;
      offset += 1;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) {
      return invalid('The JPEG segment length is inconsistent with the file.');
    }
    if (JPEG_SOF.has(marker)) {
      if (length < 7) return invalid('The JPEG frame header is truncated.');
      height = bytes.readUInt16BE(offset + 3);
      width = bytes.readUInt16BE(offset + 5);
      break;
    }
    offset += length;
  }
  if (width === 0 || height === 0) return invalid('The JPEG has no readable frame size.');
  const bound = withinPixelBound(width, height, maxPixels);
  if (bound) return bound;
  return { ok: true, mediaType: 'image/jpeg', width, height };
}

function skipSubBlocks(bytes: Buffer, start: number): number {
  let offset = start;
  let blocks = 0;
  while (offset < bytes.length) {
    blocks += 1;
    if (blocks > 4_096) return -1;
    const size = bytes[offset] ?? 0;
    offset += 1;
    if (size === 0) return offset;
    offset += size;
  }
  return -1;
}

function sniffGif(bytes: Buffer, maxPixels: number): SniffResult {
  if (bytes.length < 13) return invalid('The GIF header is truncated.');
  const width = bytes.readUInt16LE(6);
  const height = bytes.readUInt16LE(8);
  const bound = withinPixelBound(width, height, maxPixels);
  if (bound) return bound;

  const packed = bytes[10] ?? 0;
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    offset += 3 * (1 << ((packed & 0x07) + 1));
  }
  let frames = 0;
  let blocks = 0;
  while (offset < bytes.length) {
    blocks += 1;
    if (blocks > 10_000) return invalid('The GIF has too many blocks to verify safely.');
    const marker = bytes[offset];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      offset = skipSubBlocks(bytes, offset + 2);
      if (offset < 0) return invalid('The GIF extension blocks are malformed.');
      continue;
    }
    if (marker === 0x2c) {
      frames += 1;
      if (frames > 1) {
        return unsupported(
          'Animated GIF input is not supported; upload a single-frame image instead.',
        );
      }
      if (offset + 10 > bytes.length) return invalid('The GIF image descriptor is truncated.');
      const local = bytes[offset + 9] ?? 0;
      offset += 10;
      if ((local & 0x80) !== 0) {
        offset += 3 * (1 << ((local & 0x07) + 1));
      }
      if (offset >= bytes.length) return invalid('The GIF image data is truncated.');
      offset = skipSubBlocks(bytes, offset + 1);
      if (offset < 0) return invalid('The GIF image data is malformed.');
      continue;
    }
    return invalid('The GIF block stream is malformed.');
  }
  return { ok: true, mediaType: 'image/gif', width, height };
}

function sniffWebp(bytes: Buffer, maxPixels: number): SniffResult {
  if (bytes.length < 20) return invalid('The WebP header is truncated.');
  let offset = 12;
  let width = 0;
  let height = 0;
  let chunks = 0;
  while (offset + 8 <= bytes.length) {
    chunks += 1;
    if (chunks > 64) return invalid('The WebP has too many chunks to verify safely.');
    const fourcc = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) return invalid('A WebP chunk extends past the file.');
    if (fourcc === 'VP8X') {
      if (size < 10) return invalid('The WebP extended header is truncated.');
      if ((bytes[start] ?? 0) & 0x02) {
        return unsupported('Animated WebP input is not supported; upload a static image.');
      }
      width = 1 + bytes.readUIntLE(start + 4, 3);
      height = 1 + bytes.readUIntLE(start + 7, 3);
    } else if (fourcc === 'VP8 ') {
      if (start + 10 > bytes.length) return invalid('The WebP lossy frame is truncated.');
      if (
        bytes[start + 3] !== 0x9d ||
        bytes[start + 4] !== 0x01 ||
        bytes[start + 5] !== 0x2a
      ) {
        return invalid('The WebP lossy frame start code is missing.');
      }
      width = bytes.readUInt16LE(start + 6) & 0x3fff;
      height = bytes.readUInt16LE(start + 8) & 0x3fff;
    } else if (fourcc === 'VP8L') {
      if (start + 5 > bytes.length) return invalid('The WebP lossless frame is truncated.');
      if (bytes[start] !== 0x2f) return invalid('The WebP lossless signature is missing.');
      const bits = bytes.readUInt32LE(start + 1);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    offset = start + size + (size % 2);
  }
  if (width === 0 || height === 0) return invalid('The WebP has no readable frame size.');
  const bound = withinPixelBound(width, height, maxPixels);
  if (bound) return bound;
  return { ok: true, mediaType: 'image/webp', width, height };
}

export function sniffImage(bytes: Buffer, limits: { maxPixels: number }): SniffResult {
  if (bytes.length < 12) return invalid('The file is too short to identify.');

  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return sniffPng(bytes, limits.maxPixels);

  if (bytes[0] === 0xff && bytes[1] === 0xd8) return sniffJpeg(bytes, limits.maxPixels);

  const signature = bytes.toString('latin1', 0, 6);
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return sniffGif(bytes, limits.maxPixels);
  }

  if (
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return sniffWebp(bytes, limits.maxPixels);
  }

  const head = bytes.subarray(0, 512).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) {
    return unsupported('SVG can contain active content and is not accepted as image input.');
  }
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return unsupported('HTML is not accepted as image input.');
  }
  if (head.startsWith('%pdf')) {
    return unsupported('PDF input is not supported by this deployment.');
  }
  if (head.startsWith('id3') || head.startsWith('riff') || head.startsWith('ogg')) {
    return unsupported('Audio input is not supported by this deployment.');
  }
  if (head.includes('ftyp')) {
    return unsupported('Video input is not supported by this deployment.');
  }
  return unsupported(
    'The file is not a PNG, JPEG, WebP or single-frame GIF image; other formats are unavailable.',
  );
}
