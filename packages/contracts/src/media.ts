import { z } from 'zod';
import { Availability } from './capabilities.js';
import { DataMode, IsoDateTime } from './primitives.js';

/**
 * Multimodal input and creative output are versioned here, with the rest of the
 * wire contract.
 *
 * Only image input is implemented. Audio, video and document understanding are
 * described as unavailable rather than silently accepted or emulated: a client
 * reads `MediaCapabilities` to know what this deployment can actually do. A
 * supported image is identified by its magic bytes, never by the client's
 * declared content type or its file extension.
 */

export const MEDIA_MAX_BYTES = 5_242_880;
export const MEDIA_MAX_PIXELS = 40_000_000;
export const MEDIA_MAX_ATTACHMENTS = 4;
export const MEDIA_MAX_ENCODED_CHARS = 7_200_000;
export const CREATIVE_MAX_BYTES = 262_144;
export const CREATIVE_MAX_ARTIFACTS = 4;

export const MediaId = z.string().trim().min(1).max(128).describe('media identifier');
export type MediaId = z.infer<typeof MediaId>;

export const MediaKind = z.enum(['image', 'audio', 'video', 'document']);
export type MediaKind = z.infer<typeof MediaKind>;

/** The image formats the engine can identify and hand to a vision model. */
export const ImageMediaType = z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export type ImageMediaType = z.infer<typeof ImageMediaType>;

/**
 * Media metadata is owner- and mode-scoped. `width` and `height` are read from
 * the file header; the engine never decompresses an uploaded image to learn them.
 */
export const MediaDescriptor = z
  .object({
    mediaId: MediaId,
    kind: z.literal('image'),
    mediaType: ImageMediaType,
    bytes: z.number().int().min(1).max(MEDIA_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    width: z.number().int().min(1).max(65_535),
    height: z.number().int().min(1).max(65_535),
    mode: DataMode,
    createdAt: IsoDateTime,
  })
  .strict();
export type MediaDescriptor = z.infer<typeof MediaDescriptor>;

/**
 * `data` is standard base64 without a data-URL prefix. `declaredType` is only a
 * hint: a mismatch with the sniffed type is a validation failure, not a rename.
 */
export const MediaUploadRequest = z
  .object({
    mode: DataMode.default('private'),
    data: z.string().min(1).max(MEDIA_MAX_ENCODED_CHARS),
    declaredType: z.string().min(1).max(120).optional(),
  })
  .strict();
export type MediaUploadRequest = z.infer<typeof MediaUploadRequest>;

export const MediaUploadResult = z.object({ media: MediaDescriptor }).strict();
export type MediaUploadResult = z.infer<typeof MediaUploadResult>;

export const MediaDownload = z
  .object({
    media: MediaDescriptor,
    data: z.string().min(1).max(MEDIA_MAX_ENCODED_CHARS),
  })
  .strict();
export type MediaDownload = z.infer<typeof MediaDownload>;

export const MediaInputCapability = z
  .object({
    kind: MediaKind,
    available: z.boolean(),
    mediaTypes: z.array(z.string().min(1).max(120)).max(8),
    maxBytes: z.number().int().positive(),
    maxPixels: z.number().int().positive(),
    reason: Availability,
  })
  .strict();
export type MediaInputCapability = z.infer<typeof MediaInputCapability>;

/**
 * Creative output is always handed over for sandboxed rendering. The engine
 * refuses scripts and external resources instead of promising it sanitized them.
 */
export const CreativeCapability = z
  .object({
    available: z.boolean(),
    formats: z.array(z.enum(['svg', 'html'])).max(2),
    maxBytes: z.number().int().positive(),
    sandbox: z.literal('required'),
    scripts: z.literal(false),
    externalResources: z.literal(false),
    reason: Availability,
  })
  .strict();
export type CreativeCapability = z.infer<typeof CreativeCapability>;

export const MediaCapabilities = z
  .object({
    inputs: z.array(MediaInputCapability).max(8),
    creative: CreativeCapability,
    maxAttachments: z.number().int().min(1).max(8),
    /**
     * Private mode partitions stored data; it does not make a hosted provider
     * local. Sending private media off-device is therefore off by default and
     * reported here instead of being assumed.
     */
    privateModeAttachments: Availability,
  })
  .strict();
export type MediaCapabilities = z.infer<typeof MediaCapabilities>;

export const CreativeFormat = z.enum(['svg', 'html']);
export type CreativeFormat = z.infer<typeof CreativeFormat>;

/** Stable finding codes a client can localize; `detail` is explanatory text. */
export const CreativeFindingCode = z.enum([
  'script',
  'event_handler',
  'external_reference',
  'embedded_object',
  'entity',
  'style',
  'unsupported_element',
  'unsupported_attribute',
  'oversize',
  'malformed',
  'control_character',
]);
export type CreativeFindingCode = z.infer<typeof CreativeFindingCode>;

export const CreativeFinding = z
  .object({
    code: CreativeFindingCode,
    detail: z.string().min(1).max(300),
  })
  .strict();
export type CreativeFinding = z.infer<typeof CreativeFinding>;

export const CreativeValidationRequest = z
  .object({
    format: CreativeFormat,
    content: z.string().min(1).max(CREATIVE_MAX_BYTES),
  })
  .strict();
export type CreativeValidationRequest = z.infer<typeof CreativeValidationRequest>;

export const CreativeValidation = z
  .object({
    format: CreativeFormat,
    safe: z.boolean(),
    findings: z.array(CreativeFinding).max(20),
    bytes: z.number().int().nonnegative().max(CREATIVE_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sandbox: z.literal('required'),
  })
  .strict();
export type CreativeValidation = z.infer<typeof CreativeValidation>;

/**
 * An artifact extracted from agent output. `content` is present only when the
 * allowlist scan found nothing; an unsafe artifact is reported with its findings
 * and no body, so a client cannot accidentally render it.
 */
export const CreativeArtifact = z
  .object({
    artifactId: z.string().min(1).max(128),
    format: CreativeFormat,
    safe: z.boolean(),
    content: z.string().max(CREATIVE_MAX_BYTES).optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative().max(CREATIVE_MAX_BYTES),
    findings: z.array(CreativeFinding).max(20),
  })
  .strict();
export type CreativeArtifact = z.infer<typeof CreativeArtifact>;


/**
 * Multimodal input is a bounded, validated image reference. The engine accepts
 * only three raster formats it can identify from their own bytes; SVG, HTML, GIF
 * and archive formats are refused because they either execute or expand
 * unpredictably. Bytes travel inline as canonical base64, so the engine never
 * fetches a caller-supplied URL (no SSRF) and never writes an upload to disk
 * before it has been validated.
 */

export const MediaType = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type MediaType = z.infer<typeof MediaType>;


/** The same limits the intake validates, published for an early client refusal. */
export const MEDIA_LIMITS = Object.freeze({
  maxAttachments: 4,
  maxBytesPerAttachment: 2 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  /** Longest side after the header is parsed; prevents pixel bombs. */
  maxDimension: 8192,
  maxPixels: 16 * 1024 * 1024,
  maxBase64Chars: Math.ceil((2 * 1024 * 1024) / 3) * 4,
  maxNameChars: 120,
  maxAltChars: 500,
});

export const MediaAttachmentInput = z
  .object({
    kind: z.literal('image').default('image'),
    mediaType: MediaType,
    /** Canonical base64 without a `data:` prefix. */
    dataBase64: z.string().min(4).max(MEDIA_LIMITS.maxBase64Chars),
    /** Display name only; the engine never uses it as a path. */
    name: z.string().trim().max(MEDIA_LIMITS.maxNameChars).optional(),
    alt: z.string().trim().max(MEDIA_LIMITS.maxAltChars).optional(),
  })
  .strict();
export type MediaAttachmentInput = z.infer<typeof MediaAttachmentInput>;

/** What the engine stores and returns: metadata, never the bytes. */
export const MediaReference = z
  .object({
    mediaId: z.string().min(1).max(128),
    kind: z.literal('image'),
    mediaType: MediaType,
    bytes: z.number().int().positive().max(MEDIA_LIMITS.maxBytesPerAttachment),
    width: z.number().int().positive().max(MEDIA_LIMITS.maxDimension),
    height: z.number().int().positive().max(MEDIA_LIMITS.maxDimension),
    sha256: z.string().length(64),
    name: z.string().max(MEDIA_LIMITS.maxNameChars).optional(),
    alt: z.string().max(MEDIA_LIMITS.maxAltChars).optional(),
  })
  .strict();
export type MediaReference = z.infer<typeof MediaReference>;

/** One intake call validates a whole attachment set atomically. */
export const MediaIntakeRequest = z
  .object({
    attachments: z.array(MediaAttachmentInput).min(1).max(MEDIA_LIMITS.maxAttachments),
  })
  .strict();
export type MediaIntakeRequest = z.infer<typeof MediaIntakeRequest>;

/** The response carries metadata only; the bytes are never echoed back. */
export const MediaIntakeResult = z
  .object({
    media: z.array(MediaReference).min(1).max(MEDIA_LIMITS.maxAttachments),
  })
  .strict();
export type MediaIntakeResult = z.infer<typeof MediaIntakeResult>;
