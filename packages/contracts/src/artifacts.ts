import { z } from 'zod';
import { ArtifactId, IsoDateTime, TaskId } from './primitives.js';

/**
 * Artifact storage.
 *
 * An artifact is a named byte sequence a Work task produced. The engine owns the
 * bytes and the digest: `path` is owner-readable metadata, never a filesystem
 * path, so a task cannot write outside its workspace by naming `../../etc/passwd`.
 * The content is transferred as base64 inside JSON to keep one validated
 * response type; the bound is enforced by the engine before decoding.
 */
export const ArtifactMediaType = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(/^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/, 'a media type is type/subtype');

export const ArtifactPath = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (value) => !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value),
    'path must be relative',
  )
  .refine(
    (value) => !value.split(/[\\/]/).some((segment) => segment === '..'),
    'path may not traverse outside the artifact root',
  );

/**
 * Transfer bounds, declared once.
 *
 * base64 expands by 4/3, so the largest artifact the contract can carry is
 * `ARTIFACT_MAX_BYTES`. The HTTP transport reads `ARTIFACT_UPLOAD_BODY_BYTES`
 * from the route specification rather than applying one global limit, so a
 * contract-valid maximum upload is not refused before the contract sees it.
 */
export const ARTIFACT_MAX_BASE64_CHARS = 12_000_000;
export const ARTIFACT_MAX_BYTES = Math.floor(ARTIFACT_MAX_BASE64_CHARS / 4) * 3;
export const ARTIFACT_UPLOAD_BODY_BYTES = ARTIFACT_MAX_BASE64_CHARS + 32_768;

export const ArtifactUploadRequest = z
  .object({
    path: ArtifactPath,
    mediaType: ArtifactMediaType,
    /** Base64, at most `ARTIFACT_MAX_BASE64_CHARS`; the decoded bound is enforced too. */
    contentBase64: z.string().min(1).max(ARTIFACT_MAX_BASE64_CHARS),
  })
  .strict();
export type ArtifactUploadRequest = z.infer<typeof ArtifactUploadRequest>;

export const ArtifactRecord = z
  .object({
    artifactId: ArtifactId,
    taskId: TaskId,
    path: ArtifactPath,
    mediaType: ArtifactMediaType,
    bytes: z.number().int().nonnegative(),
    /** `sha256:<hex>` computed by the engine over the stored bytes. */
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    createdAt: IsoDateTime,
  })
  .strict();
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;

export const ArtifactList = z.object({ artifacts: z.array(ArtifactRecord) }).strict();
export type ArtifactList = z.infer<typeof ArtifactList>;

export const ArtifactContent = z
  .object({
    artifactId: ArtifactId,
    mediaType: ArtifactMediaType,
    bytes: z.number().int().nonnegative(),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    contentBase64: z.string(),
  })
  .strict();
export type ArtifactContent = z.infer<typeof ArtifactContent>;
