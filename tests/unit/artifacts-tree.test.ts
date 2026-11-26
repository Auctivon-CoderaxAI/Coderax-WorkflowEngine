import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ArtifactDescriptor, ArtifactMediaType } from '@coderax/contracts';
import {
  manifestFor,
  manifestFromDescriptors,
  restoreTree,
  safeRelativePath,
  TreePathError,
} from '../../src/artifacts/tree.js';

function descriptor(input: {
  artifactId: string;
  filename: string;
  relativePath?: string;
  content: string;
  mediaType?: string;
}): ArtifactDescriptor {
  const bytes = Buffer.from(input.content, 'utf8');
  return {
    artifactId: input.artifactId,
    kind: 'software',
    filename: input.filename,
    ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
    mediaType: (input.mediaType ?? 'text/plain') as ArtifactMediaType,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mode: 'cloud',
    version: 1,
    versions: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    inferenceExposure: 'none',
  };
}

const files = [
  { relativePath: 'src/index.ts', artifactId: 'art_index', content: 'export const main = 1;\n' },
  { relativePath: 'src/lib/util.ts', artifactId: 'art_util', content: 'export const util = 2;\n' },
  { relativePath: 'package.json', artifactId: 'art_pkg', content: '{"name":"tree"}\n' },
  { relativePath: 'README.md', artifactId: 'art_readme', content: '# Tree\n' },
];

function manifest() {
  return manifestFor({
    projectId: 'proj_tree',
    name: 'tree',
    entry: 'src/index.ts',
    createdAt: '2026-01-01T00:00:00.000Z',
    artifacts: files.map((file) => ({
      relativePath: file.relativePath,
      descriptor: descriptor({
        artifactId: file.artifactId,
        filename: path.posix.basename(file.relativePath),
        relativePath: file.relativePath,
        content: file.content,
        mediaType: file.relativePath.endsWith('.md') ? 'text/markdown' : file.relativePath.endsWith('.json') ? 'application/json' : 'text/plain',
      }),
    })),
  });
}

test('a manifest records global artifact identities and restores the complete tree', async () => {
  const tree = manifest();
  assert.equal(tree.projectId, 'proj_tree');
  assert.deepEqual(
    tree.files.map((file) => file.relativePath),
    ['README.md', 'package.json', 'src/index.ts', 'src/lib/util.ts'],
  );
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-tree-'));
  try {
    const contents = new Map(files.map((file) => [file.artifactId, Buffer.from(file.content, 'utf8')]));
    const restored = await restoreTree({
      root,
      manifest: tree,
      read: async (artifactId) => contents.get(artifactId) as Buffer,
    });
    assert.equal(restored.files, 4);
    assert.equal(readFileSync(path.join(root, 'src/index.ts'), 'utf8'), files[0]?.content);
    assert.equal(readFileSync(path.join(root, 'src/lib/util.ts'), 'utf8'), files[1]?.content);
    assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), files[2]?.content);
    assert.equal(readFileSync(path.join(root, 'README.md'), 'utf8'), files[3]?.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('traversal, absolute paths, duplicates and digest mismatches are refused', async () => {
  for (const candidate of ['../escape.ts', '/etc/passwd', 'src/../../escape', 'src\\win.ts', 'src//x.ts', 'C:/x.ts', 'src/.hidden/x.ts']) {
    assert.throws(() => safeRelativePath(candidate), TreePathError, candidate);
  }

  const tree = manifest();
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-tree-'));
  try {
    const contents = new Map(files.map((file) => [file.artifactId, Buffer.from(file.content, 'utf8')]));
    const traversal = { ...tree, files: tree.files.map((file, index) => index === 0 ? { ...file, relativePath: '../README.md' } : file) };
    await assert.rejects(
      restoreTree({ root, manifest: traversal, read: async (id) => contents.get(id) as Buffer }),
      TreePathError,
    );

    const duplicate = { ...tree, files: [tree.files[0]!, { ...tree.files[1]!, relativePath: tree.files[0]!.relativePath, filename: tree.files[0]!.filename }] };
    await assert.rejects(
      restoreTree({ root, manifest: duplicate, read: async (id) => contents.get(id) as Buffer }),
      TreePathError,
    );

    const tampered = { ...tree, files: tree.files.map((file, index) => index === 0 ? { ...file, sha256: '0'.repeat(64) } : file) };
    await assert.rejects(
      restoreTree({ root, manifest: tampered, read: async (id) => contents.get(id) as Buffer }),
      /digest does not match/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest is rebuilt from descriptors listed by project identity', () => {
  const descriptors = files.map((file) =>
    descriptor({
      artifactId: file.artifactId,
      filename: path.posix.basename(file.relativePath),
      relativePath: file.relativePath,
      content: file.content,
    }),
  );
  const rebuilt = manifestFromDescriptors({
    projectId: 'proj_tree',
    name: 'tree',
    entry: 'src/index.ts',
    createdAt: '2026-01-01T00:00:00.000Z',
    descriptors,
  });
  assert.equal(rebuilt.files.length, 4);
  assert.equal(rebuilt.files[2]?.artifactId, 'art_index');
});
