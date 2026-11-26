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
type ArtifactInput = {
    taskId: string;
    conversationId: string;
    path: string;
    mediaType: string;
    content: Buffer;
    origin: 'engine' | 'owner';
};
type Staged = { blob: ArtifactBlob; finish: (publish: boolean) => void };

export type ArtifactStore = {
  stage: (input: ArtifactInput) => ServiceResult<Staged>;
  write: (input: ArtifactInput) => Promise<ServiceResult<ArtifactBlob>>;
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
  type Slot = { id: string; pending: number; visible?: ArtifactBlob };
  const byTask = new Map<string, Map<string, Slot>>();

  function stage({ taskId, conversationId, path, mediaType, content, origin }: ArtifactInput): ServiceResult<Staged> {
    if (content.length > input.maxBytes) {
      return fail(
        'validation_failed',
        `An artifact may not exceed ${input.maxBytes} bytes.`,
      );
    }
    const entries = byTask.get(taskId) ?? new Map<string, Slot>();
    // The same path replaces the earlier bytes: a retried run must not leave
    // two artifacts claiming to be the same file.
    const existing = entries.get(path);
    if (!existing && entries.size >= input.maxPerTask) {
      return fail('conflict', `A task may hold at most ${input.maxPerTask} artifacts.`);
    }
    const slot = existing ?? { id: `art_${randomUUID()}`, pending: 0 };
    entries.set(path, slot);
    byTask.set(taskId, entries);
    slot.pending++;
    const blob: ArtifactBlob = {
      artifactId: slot.id,
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
    let finished = false;
    return ok({ blob, finish: (publish) => {
      if (finished) return;
      finished = true;
      if (publish) slot.visible = blob;
      slot.pending--;
      if (!slot.visible && !slot.pending) entries.delete(path);
      if (!entries.size) byTask.delete(taskId);
    } });
  }

  const visible = (taskId: string) => [...(byTask.get(taskId)?.values() ?? [])]
    .flatMap((slot) => slot.visible ? [{ ...slot.visible }] : []);
  return {
    stage,
    write: async (request) => {
      const staged = stage(request);
      if (!staged.ok) return staged;
      staged.value.finish(true);
      return ok(staged.value.blob);
    },
    list: async (taskId) => visible(taskId).sort((a, b) => a.path.localeCompare(b.path)),
    get: async (taskId, id) => visible(taskId).find((entry) => entry.artifactId === id) ?? null,
  };
}
