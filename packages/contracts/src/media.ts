import { z } from 'zod';

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
