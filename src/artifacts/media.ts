import { createHash } from 'node:crypto';
import type { ArtifactKind, ArtifactMediaType } from '@coderax/contracts';
import {
  ARTIFACT_MEDIA_TYPES,
  MAX_ARTIFACT_BASE64_CHARS,
  MAX_ARTIFACT_BYTES,
} from '@coderax/contracts';

/**
 * Content validation for stored artifacts.
 *
 * Nothing here is derived from a caller-controlled path. The storage key is a
 * digest, the file name is only metadata, and every byte is checked against the
 * declared media type before it is written. The rules are deliberately
 * conservative: a format this module cannot identify is refused instead of being
 * stored as "unknown", and no archive is ever unpacked.
 */

export type MediaFamily =
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'pdf'
  | 'office'
  | 'audio-mpeg'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'mp4'
  | 'webm'
  | 'text'
  | 'json';

export type ValidationFailure = { ok: false; code: ValidationCode; detail: string };
export type ValidationSuccess<T> = { ok: true; value: T };
export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export type ValidationCode =
  | 'validation_failed'
  | 'payload_too_large'
  | 'unsupported_media_type';

const MEDIA_SET: ReadonlySet<string> = new Set(ARTIFACT_MEDIA_TYPES);

const DOCUMENT_MEDIA = new Set<ArtifactMediaType>([
  'text/plain',
  'text/markdown',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
]);

const SPREADSHEET_MEDIA = new Set<ArtifactMediaType>([
  'text/csv',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

const PRESENTATION_MEDIA = new Set<ArtifactMediaType>([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);

const TEXT_MEDIA = new Set<ArtifactMediaType>([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
]);

const OOXML_MEDIA = new Set<ArtifactMediaType>([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const ODF_MEDIA = new Set<ArtifactMediaType>([
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'sql',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'lua',
  'dart',
  'r',
  'scala',
  'pl',
  'ex',
  'exs',
  'hs',
  'ml',
  'clj',
  'fs',
  'toml',
  'ini',
  'cfg',
  'yaml',
  'yml',
  'xml',
  'gradle',
  'dockerfile',
  'makefile',
]);

/** Extension -> media type. A declared media type must agree with the suffix. */
const EXTENSION_MEDIA: Readonly<Record<string, ArtifactMediaType>> = Object.freeze({
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
});

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isArtifactMediaType(value: string): value is ArtifactMediaType {
  return MEDIA_SET.has(value);
}

/**
 * A file name is metadata, never a storage path. Everything that could be
 * interpreted as a path, a hidden file, a Windows device or a right-to-left
 * spoof is refused instead of being silently rewritten.
 */
export function validateFilename(
  raw: string,
): ValidationResult<{ filename: string; extension: string }> {
  const filename = raw.normalize('NFC').trim();
  if (filename.length === 0 || filename.length > 200) {
    return failure('validation_failed', 'filename must contain 1–200 characters.');
  }
  if (/[/\\]/.test(filename)) {
    return failure('validation_failed', 'filename must not contain a path separator.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(filename)) {
    return failure('validation_failed', 'filename must not contain a control character.');
  }
  if (/[\u202a-\u202e\u2066-\u2069]/.test(filename)) {
    return failure('validation_failed', 'filename must not contain a bidirectional override.');
  }
  if (filename.startsWith('.')) {
    return failure('validation_failed', 'filename must not start with a dot.');
  }
  if (/[. ]$/.test(filename)) {
    return failure('validation_failed', 'filename must not end with a dot or a space.');
  }
  if (/[<>:"|?*]/.test(filename)) {
    return failure('validation_failed', 'filename contains a reserved character.');
  }
  if (WINDOWS_RESERVED.test(filename)) {
    return failure('validation_failed', 'filename must not be a reserved device name.');
  }
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
  if (extension.length === 0) {
    return failure('validation_failed', 'filename must include an extension.');
  }
  return { ok: true, value: { filename, extension } };
}

/** Canonical, unpadded base64 only: `Buffer.from` accepts too much on its own. */
export function decodeContent(text: string): ValidationResult<Buffer> {
  if (text.length === 0 || text.length > MAX_ARTIFACT_BASE64_CHARS) {
    return failure('payload_too_large', 'The encoded content exceeds the accepted size.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    return failure('validation_failed', 'contentBase64 is not canonical base64.');
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length === 0) {
    return failure('validation_failed', 'The artifact content is empty.');
  }
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    return failure('payload_too_large', 'The artifact exceeds the accepted size.');
  }
  if (bytes.toString('base64') !== text) {
    return failure('validation_failed', 'contentBase64 is not canonical base64.');
  }
  return { ok: true, value: bytes };
}

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function failure(code: ValidationCode, detail: string): ValidationFailure {
  return { ok: false, code, detail };
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString('latin1');
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((value, index) => bytes[index] === value);
}

function utf8Text(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // A NUL byte in text is either binary content or an attempt to truncate a
    // consumer's view of the file; neither belongs in a text artifact.
    return text.includes('\u0000') ? null : text;
  } catch {
    return null;
  }
}

function mp4Family(bytes: Uint8Array): MediaFamily | null {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== 'ftyp') return null;
  const brand = ascii(bytes, 8, 12);
  if (brand === 'qt  ') return 'mp4';
  if (brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ') return 'mp4';
  return 'mp4';
}

function officeContainer(bytes: Uint8Array, declared: ArtifactMediaType): boolean {
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 8192)));
  if (OOXML_MEDIA.has(declared)) {
    if (!head.includes(Buffer.from('[Content_Types].xml', 'latin1'))) return false;
    if (declared === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return head.includes(Buffer.from('word/', 'latin1'));
    }
    if (declared === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      return head.includes(Buffer.from('xl/', 'latin1'));
    }
    return head.includes(Buffer.from('ppt/', 'latin1'));
  }
  if (ODF_MEDIA.has(declared)) {
    const marker = head.toString('latin1');
    return marker.includes('mimetype') && marker.includes(declared);
  }
  return false;
}

export function detectFamily(bytes: Uint8Array): MediaFamily | 'unknown' {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12) {
    const kind = ascii(bytes, 8, 12);
    if (kind === 'WEBP') return 'webp';
    if (kind === 'WAVE') return 'wav';
  }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'office';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) return 'ogg';
  if (startsWith(bytes, [0x66, 0x4c, 0x61, 0x43])) return 'flac';
  if (startsWith(bytes, [0x49, 0x44, 0x33])) return 'audio-mpeg';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0) return 'audio-mpeg';
  const mp4 = mp4Family(bytes);
  if (mp4) return mp4;

  const text = utf8Text(bytes);
  if (text !== null) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        JSON.parse(text);
        return 'json';
      } catch {
        return 'text';
      }
    }
    return 'text';
  }
  return 'unknown';
}

const EXPECTED_FAMILIES: Readonly<Record<ArtifactMediaType, readonly MediaFamily[]>> = Object.freeze({
  'text/plain': ['text'],
  'text/markdown': ['text'],
  'text/csv': ['text'],
  'text/tab-separated-values': ['text'],
  'application/json': ['json'],
  'application/pdf': ['pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['office'],
  'application/vnd.oasis.opendocument.text': ['office'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['office'],
  'application/vnd.oasis.opendocument.spreadsheet': ['office'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['office'],
  'application/vnd.oasis.opendocument.presentation': ['office'],
  'image/png': ['png'],
  'image/jpeg': ['jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'audio/mpeg': ['audio-mpeg'],
  'audio/wav': ['wav'],
  'audio/ogg': ['ogg'],
  'audio/flac': ['flac'],
  'audio/mp4': ['mp4'],
  'video/mp4': ['mp4'],
  'video/webm': ['webm'],
  'video/ogg': ['ogg'],
  'video/quicktime': ['mp4'],
});

const COMPATIBLE_KINDS: Readonly<Record<ArtifactMediaType, readonly ArtifactKind[]>> =
  Object.freeze({
    'text/plain': [
      'document',
      'source',
      'software',
      'data',
      'execution',
      'visualization',
      'project',
      'game',
    ],
    'text/markdown': ['document', 'source', 'software', 'execution'],
    'text/csv': ['spreadsheet', 'data', 'dataset', 'execution'],
    'text/tab-separated-values': ['spreadsheet', 'data', 'dataset', 'execution'],
    'application/json': [
      'data',
      'dataset',
      'software',
      'visualization',
      'execution',
      'project',
      'game',
      'source',
    ],
    'application/pdf': ['pdf', 'document', 'visualization', 'execution'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['document'],
    'application/vnd.oasis.opendocument.text': ['document'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': [
      'spreadsheet',
      'data',
      'execution',
    ],
    'application/vnd.oasis.opendocument.spreadsheet': ['spreadsheet', 'data', 'execution'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['presentation'],
    'application/vnd.oasis.opendocument.presentation': ['presentation'],
    'image/png': ['image', 'visualization', 'execution'],
    'image/jpeg': ['image', 'visualization', 'execution'],
    'image/gif': ['image', 'visualization', 'execution'],
    'image/webp': ['image', 'visualization', 'execution'],
    'audio/mpeg': ['audio', 'execution'],
    'audio/wav': ['audio', 'execution'],
    'audio/ogg': ['audio', 'execution'],
    'audio/flac': ['audio', 'execution'],
    'audio/mp4': ['audio', 'execution'],
    'video/mp4': ['video', 'execution'],
    'video/webm': ['video', 'execution'],
    'video/ogg': ['video', 'execution'],
    'video/quicktime': ['video', 'execution'],
  });

export function defaultKindFor(
  mediaType: ArtifactMediaType,
  extension: string,
): ArtifactKind {
  if (mediaType === 'application/pdf') return 'pdf';
  if (DOCUMENT_MEDIA.has(mediaType)) {
    return SOURCE_EXTENSIONS.has(extension) ? 'source' : 'document';
  }
  if (SPREADSHEET_MEDIA.has(mediaType)) return 'spreadsheet';
  if (PRESENTATION_MEDIA.has(mediaType)) return 'presentation';
  if (mediaType === 'application/json') return 'data';
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('video/')) return 'video';
  return 'document';
}

export function compatibleKinds(mediaType: ArtifactMediaType): readonly ArtifactKind[] {
  return COMPATIBLE_KINDS[mediaType];
}

export type ValidatedContent = {
  filename: string;
  extension: string;
  mediaType: ArtifactMediaType;
  kind: ArtifactKind;
  bytes: Buffer;
  sha256: string;
};

/**
 * The single gate every byte passes through. It refuses:
 * - media types outside the allowlist, and HTML/SVG/archives by omission;
 * - a declared type that disagrees with the file signature (MIME spoofing);
 * - an extension that disagrees with the declared type;
 * - an archive that is not an opaque office document (no extraction exists);
 * - a requested kind the detected format cannot legitimately claim.
 */
export function validateContent(input: {
  filename: string;
  mediaType: ArtifactMediaType;
  content: Buffer;
  requestedKind?: ArtifactKind;
  declaredSha256?: string;
}): ValidationResult<ValidatedContent> {
  const named = validateFilename(input.filename);
  if (!named.ok) return named;

  const { filename, extension } = named.value;
  const mediaType = input.mediaType;
  if (!isArtifactMediaType(mediaType)) {
    return failure('unsupported_media_type', 'That media type is not accepted for artifacts.');
  }

  const expectedExtension = EXTENSION_MEDIA[extension];
  const sourceAsText = mediaType === 'text/plain' && SOURCE_EXTENSIONS.has(extension);
  if (sourceAsText) {
    // A source file is text/plain regardless of its language suffix.
  } else if (expectedExtension === undefined) {
    return failure('unsupported_media_type', 'That file extension is not in the artifact allowlist.');
  } else if (expectedExtension !== mediaType) {
    return failure('validation_failed', 'The file extension does not match the declared media type.');
  }

  const family = detectFamily(input.content);
  if (family === 'office' && !officeContainer(input.content, mediaType)) {
    return failure(
      'unsupported_media_type',
      'Archives are not accepted: only opaque office documents are stored, and nothing is extracted.',
    );
  }
  if (family === 'unknown' || !EXPECTED_FAMILIES[mediaType].includes(family)) {
    return failure(
      'unsupported_media_type',
      'The file signature does not match the declared media type.',
    );
  }

  if (TEXT_MEDIA.has(mediaType)) {
    const text = utf8Text(input.content);
    if (text === null) {
      return failure('validation_failed', 'A text artifact must be valid UTF-8 without NUL bytes.');
    }
  }
  if (mediaType === 'application/json') {
    const text = utf8Text(input.content);
    if (text === null) {
      return failure('validation_failed', 'A JSON artifact must be valid UTF-8 without NUL bytes.');
    }
    try {
      JSON.parse(text);
    } catch {
      return failure('validation_failed', 'The artifact is not valid JSON.');
    }
  }

  const sha256 = digestOf(input.content);
  if (input.declaredSha256 !== undefined && input.declaredSha256 !== sha256) {
    return failure('validation_failed', 'The declared sha256 does not match the uploaded bytes.');
  }

  const allowed = compatibleKinds(mediaType);
  const kind = input.requestedKind ?? defaultKindFor(mediaType, extension);
  // `other` is a deliberate escape hatch used by deliverable generators; it
  // never widens the media allowlist, which is what prevents active content.
  if (kind !== 'other' && !allowed.includes(kind)) {
    return failure(
      'validation_failed',
      `A ${mediaType} artifact cannot be stored as kind ${String(kind)}.`,
    );
  }

  return {
    ok: true,
    value: { filename, extension, mediaType, kind, bytes: input.content, sha256 },
  };
}

/** Exposed so a caller can reject an unsupported media type before decoding. */
export function acceptedMediaTypes(): readonly ArtifactMediaType[] {
  return ARTIFACT_MEDIA_TYPES;
}

const RESERVED_SEGMENTS: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

/**
 * Validates a workspace-relative path used only as artifact metadata.
 *
 * It exists so a generated software tree can be persisted file by file and
 * reconstructed from a project listing, without giving any component a path it
 * could open. Every segment is checked for traversal, separators that differ by
 * platform, control and bidirectional characters, reserved device names and
 * leading or trailing dots/spaces. The final segment must equal `filename`, so
 * a descriptor can never report two different leaf names.
 */
export function validateRelativePath(input: {
  path: string;
  filename: string;
}): ValidationResult<string> {
  const normalized = input.path.normalize('NFC');
  if (normalized.length < 1 || normalized.length > 1024) {
    return failure('validation_failed', 'A relative path must be between 1 and 1024 characters.');
  }
  if (
    normalized.startsWith('/') ||
    normalized.endsWith('/') ||
    normalized.includes('\\') ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return failure(
      'validation_failed',
      'A relative path must use forward slashes, must not be absolute and must not name a drive.',
    );
  }
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(normalized)) {
    return failure('validation_failed', 'A relative path must not contain control characters.');
  }

  const segments = normalized.split('/');
  if (segments.length > 64) {
    return failure('validation_failed', 'A relative path may contain at most 64 segments.');
  }
  for (const segment of segments) {
    if (segment.length < 1 || segment.length > 255) {
      return failure('validation_failed', 'Each path segment must be between 1 and 255 characters.');
    }
    if (segment === '.' || segment === '..') {
      return failure('validation_failed', 'A relative path must not contain dot segments.');
    }
    if (segment.startsWith('.') || segment.endsWith('.')) {
      return failure('validation_failed', 'A path segment must not start or end with a dot.');
    }
    if (segment.startsWith(' ') || segment.endsWith(' ')) {
      return failure('validation_failed', 'A path segment must not start or end with a space.');
    }
    if (/[<>:"|?*]/.test(segment)) {
      return failure('validation_failed', 'A path segment contains a reserved character.');
    }
    const device = (segment.split('.')[0] ?? '').toUpperCase();
    if (RESERVED_SEGMENTS.has(device)) {
      return failure('validation_failed', 'A path segment uses a reserved device name.');
    }
  }

  const leaf = segments[segments.length - 1] ?? '';
  if (leaf !== input.filename.normalize('NFC')) {
    return failure('validation_failed', 'The relative path basename must equal filename.');
  }
  return { ok: true, value: normalized };
}
