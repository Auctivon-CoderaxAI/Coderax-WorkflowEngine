import { createHash, randomUUID } from 'node:crypto';
import type { ArtifactEncoding, ArtifactRecord } from '@coderax/contracts';
import type { ArtifactBlob } from '../domain.js';
import type { Clock } from '../support/clock.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';

/**
 * Artifacts are stored by task and addressed by path.
 *
 * The digest is computed here over the bytes that are actually retained, so a
 * client can verify a download against the record. Content is bounded by the
 * same ceiling as an HTTP body: an artifact is not a way to smuggle a large file
 * past the transport limit.
 */
export type ArtifactStore = {
  write: (input: {
    taskId: string;
    conversationId: string;
    path: string;
    mediaType: string;
    content: Buffer;
    origin: 'engine' | 'owner';
  }) => Promise<ServiceResult<ArtifactBlob>>;
  list: (taskId: string) => Promise<ArtifactBlob[]>;
  get: (taskId: string, artifactId: string) => Promise<ArtifactBlob | null>;
};

export function digestOf(content: Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** True when the bytes are valid UTF-8, which decides how a read is encoded. */
export function isUtf8(content: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

export function encodingFor(record: ArtifactBlob): ArtifactEncoding {
  return isUtf8(record.content) ? 'utf8' : 'base64';
}

export function toArtifactRecord(blob: ArtifactBlob): ArtifactRecord {
  return {
    artifactId: blob.artifactId,
    taskId: blob.taskId,
    conversationId: blob.conversationId,
    path: blob.path,
    mediaType: blob.mediaType,
    bytes: blob.bytes,
    digest: blob.digest,
    origin: blob.origin,
    createdAt: blob.createdAt,
  };
}

export function createArtifactStore(input: {
  clock: Clock;
  maxBytes: number;
  maxPerTask: number;
}): ArtifactStore {
  const byTask = new Map<string, Map<string, ArtifactBlob>>();

  function bucket(taskId: string): Map<string, ArtifactBlob> {
    const existing = byTask.get(taskId);
    if (existing) return existing;
    const created = new Map<string, ArtifactBlob>();
    byTask.set(taskId, created);
    return created;
  }

  return {
    write: async ({ taskId, conversationId, path, mediaType, content, origin }) => {
      if (content.length > input.maxBytes) {
        return fail(
          'validation_failed',
          `An artifact may not exceed ${input.maxBytes} bytes.`,
        );
      }
      const entries = bucket(taskId);
      // The same path replaces the earlier bytes: a retried run must not leave
      // two artifacts claiming to be the same file.
      const existing = [...entries.values()].find((entry) => entry.path === path);
      if (!existing && entries.size >= input.maxPerTask) {
        return fail('conflict', `A task may hold at most ${input.maxPerTask} artifacts.`);
      }
      const blob: ArtifactBlob = {
        artifactId: existing?.artifactId ?? `art_${randomUUID()}`,
        taskId,
        conversationId,
        path,
        mediaType,
        bytes: content.length,
        digest: digestOf(content),
        origin,
        createdAt: input.clock.iso(),
        content,
      };
      entries.set(blob.artifactId, blob);
      return ok(blob);
    },
    list: async (taskId) =>
      [...bucket(taskId).values()]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => ({ ...entry })),
    get: async (taskId, artifactId) => {
      const found = bucket(taskId).get(artifactId);
      return found ? { ...found } : null;
    },
  };
}
