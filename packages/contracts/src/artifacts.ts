import { z } from 'zod';
import {
  ArtifactId,
  ConversationId,
  IsoDateTime,
  TaskId,
} from './primitives.js';

/**
 * Artifacts are the files a run produced, addressed by task.
 *
 * The digest is computed by the engine over the stored bytes, so a client can
 * verify that what it downloaded is what the engine recorded. `bytes` and
 * `digest` are never supplied by a caller: a caller that could state them could
 * lie about content the engine is about to hand to someone else.
 */

/** 1 MiB, the same ceiling the HTTP transport enforces for a request body. */
export const ARTIFACT_MAX_BYTES = 1_048_576;
/** Beyond this a task's artifact list is truncated at write time, not read time. */
export const ARTIFACT_MAX_PER_TASK = 64;

export const ArtifactOrigin = z.enum(['engine', 'owner']);
export type ArtifactOrigin = z.infer<typeof ArtifactOrigin>;

export const ArtifactRecord = z
  .object({
    artifactId: ArtifactId,
    taskId: TaskId,
    conversationId: ConversationId,
    path: z.string().min(1).max(1024),
    mediaType: z.string().min(1).max(160),
    bytes: z.number().int().nonnegative(),
    /** `sha256:` followed by lowercase hex, computed over the stored bytes. */
    digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/, 'digest must be sha256:<64 lowercase hex characters>'),
    origin: ArtifactOrigin,
    createdAt: IsoDateTime,
  })
  .strict();
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;

export const ArtifactList = z.object({ artifacts: z.array(ArtifactRecord) }).strict();
export type ArtifactList = z.infer<typeof ArtifactList>;

export const ArtifactEncoding = z.enum(['utf8', 'base64']);
export type ArtifactEncoding = z.infer<typeof ArtifactEncoding>;

export const ArtifactContent = z
  .object({
    artifact: ArtifactRecord,
    encoding: ArtifactEncoding,
    content: z.string(),
  })
  .strict();
export type ArtifactContent = z.infer<typeof ArtifactContent>;

export const ArtifactCreateRequest = z
  .object({
    path: z.string().min(1).max(1024),
    mediaType: z.string().min(1).max(160).default('text/plain'),
    encoding: ArtifactEncoding.default('utf8'),
    /** Bounded so a base64 payload cannot exceed the transport's body limit. */
    content: z.string().max(700_000),
  })
  .strict();
export type ArtifactCreateRequest = z.infer<typeof ArtifactCreateRequest>;
export type ArtifactCreateRequestInput = z.input<typeof ArtifactCreateRequest>;
