import type {
  ArtifactKind,
  ArtifactMediaType,
  ArtifactProjectManifest,
  DataMode,
} from '@coderax/contracts';
import { artifactPathKey } from '../persistence/artifacts.js';
import type { Principal } from '../security/auth.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import { validateContent, validateRelativePath } from './media.js';
import type { ArtifactService } from './service.js';

/**
 * The persistence adapter for a generator.
 *
 * A generator owns bytes and a tree shape; this adapter owns the durable
 * identity. It validates the whole batch before writing, maps an existing path
 * to a new immutable version instead of creating a second file, and uses the
 * project manifest as the restoration unit. It is deliberately not a store and
 * owns no quota ledger: every write goes through `ArtifactService`.
 */
export type GeneratedArtifactFile = {
  relativePath: string;
  mediaType: ArtifactMediaType;
  kind?: ArtifactKind;
  content: Uint8Array;
  note?: string;
};

export type TreeWriteRequest = {
  projectId: string;
  mode: DataMode;
  files: GeneratedArtifactFile[];
  conversationId?: string;
  taskId?: string;
  retentionDays?: number;
};

export type TreeWriteResult = {
  projectId: string;
  files: ArtifactProjectManifest['files'];
  manifest: ArtifactProjectManifest;
};

type PlannedFile = {
  relativePath: string;
  pathKey: string;
  filename: string;
  mediaType: ArtifactMediaType;
  kind: ArtifactKind;
  sha256: string;
  contentBase64: string;
  note?: string;
};

export function createArtifactTreeWriter(deps: { artifacts: ArtifactService }) {
  return {
    persist: async (
      principal: Principal,
      request: TreeWriteRequest,
    ): Promise<ServiceResult<TreeWriteResult>> => {
      if (request.files.length === 0) {
        return fail('validation_failed', 'A project tree must contain at least one file.');
      }

      const planned: PlannedFile[] = [];
      const keys = new Set<string>();
      for (const file of request.files) {
        const filename = file.relativePath.split('/').at(-1) ?? '';
        const relative = validateRelativePath({
          path: file.relativePath,
          filename,
        });
        if (!relative.ok) return fail(relative.code, relative.detail);
        const content = Buffer.from(file.content);
        const validated = validateContent({
          filename,
          mediaType: file.mediaType,
          content,
          ...(file.kind ? { requestedKind: file.kind } : {}),
        });
        if (!validated.ok) return fail(validated.code, validated.detail);

        const pathKey = artifactPathKey(relative.value);
        if (keys.has(pathKey)) {
          return fail('conflict', `The tree contains the same path twice: ${relative.value}.`);
        }
        keys.add(pathKey);
        planned.push({
          relativePath: relative.value,
          pathKey,
          filename: validated.value.filename,
          mediaType: validated.value.mediaType,
          kind: validated.value.kind,
          sha256: validated.value.sha256,
          contentBase64: Buffer.from(validated.value.bytes).toString('base64'),
          ...(file.note ? { note: file.note } : {}),
        });
      }

      // A path cannot be both a file and a directory. The service also checks
      // this against stored rows; checking the batch first avoids a partial
      // write when the input itself is inconsistent.
      for (const file of planned) {
        let slash = file.pathKey.indexOf('/');
        while (slash !== -1) {
          if (keys.has(file.pathKey.slice(0, slash))) {
            return fail(
              'conflict',
              `The tree uses ${file.relativePath} both as a file and as a directory.`,
            );
          }
          slash = file.pathKey.indexOf('/', slash + 1);
        }
      }

      const current = await deps.artifacts.manifest(principal, {
        mode: request.mode,
        projectId: request.projectId,
      });
      if (!current.ok) return current;
      const existing = new Map(
        current.value.files.map((entry) => [artifactPathKey(entry.relativePath), entry]),
      );

      const created: string[] = [];
      for (const file of planned) {
        const previous = existing.get(file.pathKey);
        if (previous?.sha256 === file.sha256 && previous.relativePath === file.relativePath &&
            previous.kind === file.kind && previous.mediaType === file.mediaType) continue;
        const body = {
          filename: file.filename,
          relativePath: file.relativePath,
          mediaType: file.mediaType,
          kind: file.kind,
          contentBase64: file.contentBase64,
          mode: request.mode,
          ...(file.note ? { note: file.note } : {}),
        };
        const written = previous
          ? await deps.artifacts.addVersion(principal, previous.artifactId, body)
          : await deps.artifacts.upload(principal, {
              ...body,
              projectId: request.projectId,
              ...(request.conversationId ? { conversationId: request.conversationId } : {}),
              ...(request.taskId ? { taskId: request.taskId } : {}),
              ...(request.retentionDays !== undefined
                ? { retentionDays: request.retentionDays }
                : {}),
            });
        if (!written.ok) {
          // New artifacts from this batch are removed. Existing artifacts keep
          // their already-written versions; a multi-file edit is not one Mongo
          // transaction on a standalone deployment, so the caller gets a failed
          // result and a coherent, if partially edited, manifest.
          for (const artifactId of created) {
            await deps.artifacts.remove(principal, artifactId, request.mode).catch(() => undefined);
          }
          return written;
        }
        if (!previous) created.push(written.value.artifact.artifactId);
      }

      const manifest = await deps.artifacts.manifest(principal, {
        mode: request.mode,
        projectId: request.projectId,
      });
      if (!manifest.ok) return manifest;
      return ok({
        projectId: request.projectId,
        files: manifest.value.files,
        manifest: manifest.value,
      });
    },
  };
}
