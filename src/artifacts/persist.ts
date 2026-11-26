import {
  DocumentSourceArtifact,
  MAX_ARTIFACT_BYTES,
  type ArtifactDescriptor,
  type DataMode,
  type DeliverableProject,
  type DeliverableSource,
  type DocumentFormat,
} from '@coderax/contracts';
import { readFile } from 'node:fs/promises';
import type { ArtifactService } from './service.js';
import type { Principal } from '../security/auth.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { ProducedDeliverable, StagedArtifact } from './types.js';
import { digestOf } from './file.js';
import { createArtifactTreeWriter } from './tree.js';

/**
 * The single bridge between generation and the durable artifact service.
 *
 * The generator hands over verified bytes in staging; this module stores them
 * through the authoritative service and returns its descriptors. Nothing here
 * invents metadata: the artifact id, version, digest and storage date are the
 * service's. A deliverable is reported as created only after every file was
 * stored, and a failure rolls back the artifacts this call created so a partial
 * deliverable is not left behind.
 */

export type PersistInput = {
  artifacts: ArtifactService;
  principal: Principal;
  mode: DataMode;
  produced: ProducedDeliverable;
  note: string;
  conversationId?: string;
  taskId?: string;
  projectId?: string;
  signal?: AbortSignal;
};

export type PersistedDeliverable = {
  descriptors: ArtifactDescriptor[];
  source?: DeliverableSource;
  project?: DeliverableProject;
};

type Stored = {
  staged: StagedArtifact;
  descriptor: ArtifactDescriptor;
  created: boolean;
};

function duplicatePaths(files: StagedArtifact[]): string | null {
  const seen = new Set<string>();
  for (const file of files) {
    // A tree path identifies a file inside a project; a flat deliverable has
    // only its name. Both are compared after Unicode normalisation.
    const key = (file.projectPath ?? file.filename).normalize('NFC').toLowerCase();
    if (seen.has(key)) return file.projectPath ?? file.filename;
    seen.add(key);
  }
  return null;
}

export async function persistProduced(
  input: PersistInput,
): Promise<ServiceResult<PersistedDeliverable>> {
  const duplicate = duplicatePaths(input.produced.files);
  if (duplicate) {
    return fail(
      'validation_failed',
      `Two produced files normalize to the same path (${duplicate}).`,
    );
  }
  for (const file of input.produced.files) {
    if (file.bytes > MAX_ARTIFACT_BYTES) {
      return fail(
        'payload_too_large',
        `A produced file exceeds the ${MAX_ARTIFACT_BYTES}-byte artifact limit.`,
      );
    }
  }

  const stored: Stored[] = [];
  const rollback = async (): Promise<void> => {
    for (const entry of [...stored].reverse()) {
      if (!entry.created) continue;
      await input.artifacts
        .remove(input.principal, entry.descriptor.artifactId, input.mode)
        .catch(() => undefined);
    }
  };
  const aborted = (): boolean => input.signal?.aborted === true;

  const store = async (file: StagedArtifact): Promise<ServiceResult<Stored>> => {
    if (aborted()) return fail('cancelled', 'The deliverable was cancelled before it was stored.');
    let content: Buffer;
    try {
      content = await readFile(file.absolute);
    } catch {
      return fail('storage_unavailable', 'A staged file disappeared before it could be stored.');
    }
    if (content.length !== file.bytes || digestOf(content) !== file.sha256) {
      return fail(
        'internal_error',
        'A staged file did not match the digest recorded when it was verified.',
      );
    }
    const request = {
      filename: file.filename,
      mediaType: file.mediaType,
      contentBase64: content.toString('base64'),
      sha256: file.sha256,
      kind: file.kind,
      mode: input.mode,
      note: input.note.slice(0, 500),
      ...(file.projectPath ? { relativePath: file.projectPath } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
    if (file.versionOf) {
      const appended = await input.artifacts.addVersion(input.principal, file.versionOf.artifactId, {
        ...request,
        ...(file.versionOf.expectedVersion !== undefined
          ? { expectedVersion: file.versionOf.expectedVersion }
          : {}),
      });
      if (!appended.ok) return appended;
      return ok({ staged: file, descriptor: appended.value.artifact, created: false });
    }
    const uploaded = await input.artifacts.upload(input.principal, {
      ...request,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
    if (!uploaded.ok) return uploaded;
    return ok({ staged: file, descriptor: uploaded.value.artifact, created: true });
  };

  const storeAll = async (files: StagedArtifact[]): Promise<ServiceResult<Stored[]>> => {
    const results: Stored[] = [];
    for (const file of files) {
      const result = await store(file);
      if (!result.ok) return fail(result.code, result.detail, result.retryable);
      results.push(result.value);
      stored.push(result.value);
    }
    return ok(results);
  };

  const outputs = input.produced.files.filter((file) => file.role === 'output');
  const parts = input.produced.files.filter((file) => file.role === 'part');

  const outputResult = await storeAll(outputs);
  if (!outputResult.ok) {
    await rollback();
    return outputResult;
  }
  if (!input.produced.project) {
    const partResult = await storeAll(parts);
    if (!partResult.ok) {
      await rollback();
      return partResult;
    }
  }

  let source: DeliverableSource | undefined;

  let project: DeliverableProject | undefined;
  const treeDescriptors: ArtifactDescriptor[] = [];

  if (input.produced.project) {
    if (!input.projectId) {
      await rollback();
      return fail(
        'validation_failed',
        'A generated project must name the projectId its files belong to.',
      );
    }
    const files = [];
    for (const file of parts) {
      let content: Buffer;
      try {
        content = await readFile(file.absolute);
      } catch {
        await rollback();
        return fail('storage_unavailable', 'A staged file disappeared before it could be stored.');
      }
      if (content.length !== file.bytes || digestOf(content) !== file.sha256) {
        await rollback();
        return fail(
          'internal_error',
          'A staged file did not match the digest recorded when it was verified.',
        );
      }
      files.push({
        relativePath: file.projectPath ?? file.filename,
        mediaType: file.mediaType,
        kind: file.kind,
        content,
        note: input.note.slice(0, 500),
      });
    }
    // The store owns tree identity: it validates the whole batch, reuses the
    // artifact that already holds a path, and derives the manifest from rows.
    const written = await createArtifactTreeWriter({ artifacts: input.artifacts }).persist(
      input.principal,
      {
        projectId: input.projectId,
        mode: input.mode,
        files,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
    );
    if (!written.ok) {
      await rollback();
      return written;
    }
    for (const entry of written.value.manifest.files) {
      const descriptor = await input.artifacts.get(input.principal, entry.artifactId, input.mode);
      if (!descriptor.ok) {
        await rollback();
        return descriptor;
      }
      treeDescriptors.push(descriptor.value);
    }
    project = { projectId: written.value.projectId, manifest: written.value.manifest };
  }

  if (input.produced.document) {
    const plan = input.produced.document;
    const formats: DocumentFormat[] = [];
    for (const file of outputs) {
      if (file.format && !formats.includes(file.format)) formats.push(file.format);
    }
    const mapped = formats
      .map((format) => {
        const match = stored.find((candidate) => candidate.staged.format === format);
        if (!match) return null;
        return {
          format,
          artifactId: match.descriptor.artifactId,
          version: match.descriptor.version,
          filename: match.descriptor.filename,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const body = DocumentSourceArtifact.safeParse({
      version: 1,
      document: plan.model,
      outputs: mapped,
    });
    if (!body.success) {
      await rollback();
      return fail('internal_error', 'The document model could not be serialised for storage.');
    }
    const text = `${JSON.stringify(body.data, null, 2)}\n`;
    const digest = digestOf(text);
    if (plan.versionOf) {
      const appended = await input.artifacts.addVersion(
        input.principal,
        plan.versionOf.artifactId,
        {
          filename: plan.filename,
          mediaType: 'application/json',
          contentBase64: Buffer.from(text, 'utf8').toString('base64'),
          sha256: digest,
          kind: 'source',
          mode: input.mode,
          note: input.note.slice(0, 500),
          expectedVersion: plan.versionOf.expectedVersion,
        },
      );
      if (!appended.ok) {
        await rollback();
        return appended;
      }
      source = {
        artifactId: appended.value.artifact.artifactId,
        version: appended.value.artifact.version,
        format: 'document.json',
      };
      stored.push({
        staged: {
          filename: plan.filename,
          absolute: '',
          bytes: Buffer.byteLength(text, 'utf8'),
          sha256: digest,
          kind: 'source',
          mediaType: 'application/json',
          title: 'editable model',
          role: 'source',
        },
        descriptor: appended.value.artifact,
        created: false,
      });
    } else {
      const uploaded = await input.artifacts.upload(input.principal, {
        filename: plan.filename,
        mediaType: 'application/json',
        contentBase64: Buffer.from(text, 'utf8').toString('base64'),
        sha256: digest,
        kind: 'source',
        mode: input.mode,
        note: input.note.slice(0, 500),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      if (!uploaded.ok) {
        await rollback();
        return uploaded;
      }
      source = {
        artifactId: uploaded.value.artifact.artifactId,
        version: uploaded.value.artifact.version,
        format: 'document.json',
      };
      stored.push({
        staged: {
          filename: plan.filename,
          absolute: '',
          bytes: Buffer.byteLength(text, 'utf8'),
          sha256: digest,
          kind: 'source',
          mediaType: 'application/json',
          title: 'editable model',
          role: 'source',
        },
        descriptor: uploaded.value.artifact,
        created: true,
      });
    }
  }

  return ok({
    descriptors: [...stored.map((entry) => entry.descriptor), ...treeDescriptors],
    ...(source ? { source } : {}),
    ...(project ? { project } : {}),
  });
}
