import { z } from 'zod';
import {
  ArtifactId,
  ConversationId,
  DataMode,
  IsoDateTime,
  ProjectId,
  Sha256,
  TaskId,
} from './primitives.js';

/**
 * Durable artifacts.
 *
 * An artifact is the authoritative record of a file the owner uploaded or the
 * engine generated. The bytes are content-addressed and stored behind the same
 * durable persistence the rest of the engine uses; the descriptor is the only
 * shape a client sees. Padding, offsets and storage keys never appear on the
 * wire.
 *
 * Two boundaries are contractual rather than advisory:
 *
 * - `inferenceExposure` is the literal `'none'`. An artifact is never handed to
 *   a model or an external agent implicitly; only an explicit, scoped read by
 *   the owner through this API retrieves it.
 * - Media types are a closed allowlist. Executable, scriptable and generic
 *   archive formats are not on it, so a stored artifact cannot become a code
 *   path and archive contents are never expanded.
 */

/** Decoded byte ceiling for one artifact version. */
export const MAX_ARTIFACT_BYTES = 10_485_760;
/** Base64 ceiling for a request body carrying one version. */
export const MAX_ARTIFACT_BASE64_CHARS = 14_000_000;
/** JSON envelope ceiling for upload operations, including base64 expansion. */
export const ARTIFACT_BODY_LIMIT_BYTES = 16_777_216;

export const ArtifactKind = z.enum([
  'document',
  'pdf',
  'spreadsheet',
  'presentation',
  'image',
  'audio',
  'video',
  'source',
  'project',
  'game',
  'visualization',
  'execution',
  'data',
  'software',
  'dataset',
  'other',
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/**
 * The accepted media types. `text/html`, `image/svg+xml` and every generic
 * archive type are deliberately absent: a client that renders a download must
 * never receive active content from this service.
 */
export const ARTIFACT_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
] as const;

export const ArtifactMediaType = z.enum(ARTIFACT_MEDIA_TYPES);
export type ArtifactMediaType = z.infer<typeof ArtifactMediaType>;

export const ArtifactFilename = z.string().trim().min(1).max(200).describe('artifact file name');

export const ArtifactDescriptor = z
  .object({
    artifactId: ArtifactId,
    kind: ArtifactKind,
    filename: ArtifactFilename,
    /**
     * A validated workspace-relative path for a file inside a multi-file
     * project. It is metadata only: storage keys are digests, and no path is
     * ever opened. The basename always equals `filename`.
     */
    relativePath: z.string().min(1).max(1024).optional(),
    mediaType: ArtifactMediaType,
    bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
    /** Lowercase hex SHA-256 of the current version's exact bytes. */
    sha256: Sha256,
    mode: DataMode,
    version: z.number().int().positive(),
    /** Retained version count, including the current one. */
    versions: z.number().int().positive(),
    projectId: ProjectId.optional(),
    conversationId: ConversationId.optional(),
    taskId: TaskId.optional(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    expiresAt: IsoDateTime.optional(),
    /**
     * Immutable. The service has no path that submits artifact content to a
     * model, an adapter or an inference provider.
     */
    inferenceExposure: z.literal('none'),
  })
  .strict();
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptor>;

export const ArtifactVersionDescriptor = z
  .object({
    artifactId: ArtifactId,
    version: z.number().int().positive(),
    filename: ArtifactFilename,
    relativePath: z.string().min(1).max(1024).optional(),
    mediaType: ArtifactMediaType,
    kind: ArtifactKind,
    bytes: z.number().int().nonnegative().max(MAX_ARTIFACT_BYTES),
    sha256: Sha256,
    createdAt: IsoDateTime,
    note: z.string().max(500).optional(),
  })
  .strict();
export type ArtifactVersionDescriptor = z.infer<typeof ArtifactVersionDescriptor>;

export const ArtifactQuota = z
  .object({
    usedBytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative(),
    artifacts: z.number().int().nonnegative(),
    maxArtifacts: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactQuota = z.infer<typeof ArtifactQuota>;

export const ArtifactDescriptorList = z
  .object({ artifacts: z.array(ArtifactDescriptor), quota: ArtifactQuota })
  .strict();
export type ArtifactDescriptorList = z.infer<typeof ArtifactDescriptorList>;

export const ArtifactVersionList = z
  .object({ artifactId: ArtifactId, versions: z.array(ArtifactVersionDescriptor) })
  .strict();
export type ArtifactVersionList = z.infer<typeof ArtifactVersionList>;

/**
 * Upload accepts base64 so the bytes travel through the single validated JSON
 * surface instead of a second transport contract. `sha256` is optional; when a
 * client sends it, a mismatch rejects the upload rather than storing different
 * bytes than the client believes it sent.
 */
export const ArtifactUploadRequest = z
  .object({
    filename: ArtifactFilename,
    relativePath: z.string().min(1).max(1024).optional(),
    mediaType: ArtifactMediaType,
    contentBase64: z.string().min(1).max(MAX_ARTIFACT_BASE64_CHARS),
    sha256: Sha256.optional(),
    kind: ArtifactKind.optional(),
    mode: DataMode.default('private'),
    projectId: ProjectId.optional(),
    conversationId: ConversationId.optional(),
    taskId: TaskId.optional(),
    /** 0 keeps the artifact until it is deleted. Bounded by engine config. */
    retentionDays: z.number().int().min(0).max(3650).optional(),
    note: z.string().max(500).optional(),
  })
  .strict();
export type ArtifactUploadRequest = z.infer<typeof ArtifactUploadRequest>;

export const ArtifactVersionRequest = z
  .object({
    filename: ArtifactFilename,
    relativePath: z.string().min(1).max(1024).optional(),
    mediaType: ArtifactMediaType,
    contentBase64: z.string().min(1).max(MAX_ARTIFACT_BASE64_CHARS),
    sha256: Sha256.optional(),
    kind: ArtifactKind.optional(),
    mode: DataMode.default('private'),
    retentionDays: z.number().int().min(0).max(3650).optional(),
    note: z.string().max(500).optional(),
    /**
     * Optimistic concurrency. When a caller read version N and sends N here, the
     * append happens only while the artifact is still at N; otherwise the write
     * is refused with `conflict` instead of silently replacing a concurrent edit.
     */
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();
export type ArtifactVersionRequest = z.infer<typeof ArtifactVersionRequest>;

export const ArtifactUploadResult = z
  .object({ artifact: ArtifactDescriptor, version: ArtifactVersionDescriptor })
  .strict();
export type ArtifactUploadResult = z.infer<typeof ArtifactUploadResult>;

export const ArtifactContent = z
  .object({
    artifact: ArtifactDescriptor,
    version: ArtifactVersionDescriptor,
    contentBase64: z.string().max(MAX_ARTIFACT_BASE64_CHARS),
  })
  .strict();
export type ArtifactContent = z.infer<typeof ArtifactContent>;

/**
 * A portable export: the descriptor, every retained version's metadata and the
 * exact bytes of one version. Export never widens access; it is the same
 * owner-scoped read as a download with the version manifest attached.
 */
export const ArtifactExport = z
  .object({
    artifact: ArtifactDescriptor,
    versions: z.array(ArtifactVersionDescriptor),
    version: ArtifactVersionDescriptor,
    contentBase64: z.string().max(MAX_ARTIFACT_BASE64_CHARS),
    exportedAt: IsoDateTime,
  })
  .strict();
export type ArtifactExport = z.infer<typeof ArtifactExport>;

export const ArtifactModeRequest = z.object({ mode: DataMode.default('private') }).strict();
export type ArtifactModeRequest = z.infer<typeof ArtifactModeRequest>;

export const ArtifactDeleteResult = z
  .object({
    artifactId: ArtifactId,
    deletedVersions: z.number().int().nonnegative(),
    releasedBytes: z.number().int().nonnegative(),
  })
  .strict();
export type ArtifactDeleteResult = z.infer<typeof ArtifactDeleteResult>;

export const ArtifactPruneResult = z
  .object({
    pruned: z.number().int().nonnegative(),
    releasedBytes: z.number().int().nonnegative(),
    at: IsoDateTime,
  })
  .strict();
export type ArtifactPruneResult = z.infer<typeof ArtifactPruneResult>;
