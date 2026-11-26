import { z } from 'zod';
import { ModelRef } from './primitives.js';

/**
 * Multimodal input is a bounded, validated image reference. The engine accepts
 * only three raster formats it can identify from their own bytes; SVG, HTML,
 * GIF and archive formats are refused because they either execute or expand
 * unpredictably. Bytes travel inline as canonical base64, so the engine never
 * fetches a caller-supplied URL (no SSRF) and never writes an upload to disk
 * before it has been validated.
 */

export const MediaType = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export type MediaType = z.infer<typeof MediaType>;

export const MediaKind = z.literal('image');
export type MediaKind = z.infer<typeof MediaKind>;

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
    kind: MediaKind.default('image'),
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
    kind: MediaKind,
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


/**
 * Creative output is text-shaped by design: Markdown, an HTML fragment or an
 * SVG document. A text model can produce it at zero cost, and the engine can
 * validate it before it reaches a renderer. Raster image generation is a
 * different capability and is reported unavailable unless a verified zero-cost
 * image model exists — which this engine does not claim.
 */
export const CreativeFormat = z.enum(['markdown', 'html', 'svg']);
export type CreativeFormat = z.infer<typeof CreativeFormat>;

export const CreativeRequest = z
  .object({
    format: CreativeFormat,
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type CreativeRequest = z.infer<typeof CreativeRequest>;

/**
 * The model registry is the one place that reports what is actually available.
 * `imageGeneration.available` is a literal false: there is no paid fallback and
 * no placeholder image provider, so a client can keep that affordance disabled
 * without guessing.
 */
export const ModelMediaCapability = z
  .object({
    imageInput: z
      .object({
        available: z.boolean(),
        models: z.array(ModelRef),
      })
      .strict(),
    imageGeneration: z
      .object({
        available: z.literal(false),
        detail: z.string().min(1).max(500),
      })
      .strict(),
    creativeText: z
      .object({
        available: z.boolean(),
        formats: z.array(CreativeFormat),
      })
      .strict(),
  })
  .strict();
export type ModelMediaCapability = z.infer<typeof ModelMediaCapability>;

export const CREATIVE_FORMATS: readonly CreativeFormat[] = Object.freeze([
  'markdown',
  'html',
  'svg',
]);

/** Raster generation is not implemented and is never silently substituted. */
export const IMAGE_GENERATION_UNAVAILABLE =
  'No verified zero-cost image-generation model is configured; Coderax does not fall back to a paid image provider.';
