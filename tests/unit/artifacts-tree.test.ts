import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArtifactTreeWriter } from '../../src/artifacts/tree.js';
import {
  artifactHarness,
  codeBytes,
  ooxmlBytes,
  pdfBytes,
  textBytes,
} from '../fixtures/artifacts.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;

function files(source = 'export const answer = 42;\n') {
  return [
    {
      relativePath: 'docs/report.docx',
      mediaType: DOCX,
      kind: 'document' as const,
      content: ooxmlBytes('docx'),
    },
    {
      relativePath: 'docs/report.pdf',
      mediaType: 'application/pdf' as const,
      kind: 'pdf' as const,
      content: pdfBytes('generated report'),
    },
    {
      relativePath: 'sheets/book.xlsx',
      mediaType: XLSX,
      kind: 'spreadsheet' as const,
      content: ooxmlBytes('xlsx'),
    },
    {
      relativePath: 'slides/deck.pptx',
      mediaType: PPTX,
      kind: 'presentation' as const,
      content: ooxmlBytes('pptx'),
    },
    {
      relativePath: 'src/index.ts',
      mediaType: 'text/plain' as const,
      kind: 'software' as const,
      content: textBytes(source),
    },
    {
      relativePath: 'package.json',
      mediaType: 'application/json' as const,
      kind: 'software' as const,
      content: textBytes('{"name":"generated","private":true}'),
    },
  ];
}

test('generated documents, workbooks, decks, PDFs and a source tree persist, version and restore', async () => {
  const h = artifactHarness();
  const writer = createArtifactTreeWriter({ artifacts: h.service });

  const first = await writer.persist(h.owner, {
    projectId: 'proj_generated',
    mode: 'cloud',
    files: files(),
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.files.length, 6);
  assert.match(first.value.manifest.digest, /^[0-9a-f]{64}$/);

  for (const entry of first.value.files) {
    const downloaded = await h.service.download(h.owner, entry.artifactId, {
      mode: 'cloud',
      version: entry.version,
    });
    assert.equal(downloaded.ok, true, entry.relativePath);
  }

  const second = await writer.persist(h.owner, {
    projectId: 'proj_generated',
    mode: 'cloud',
    files: files('export const answer = 43;\n'),
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const source = second.value.files.find((entry) => entry.relativePath === 'src/index.ts');
  assert.ok(source);
  assert.equal(source.version, 2);

  const old = await h.service.download(h.owner, source.artifactId, {
    mode: 'cloud',
    version: 1,
  });
  assert.equal(old.ok, true);
  if (old.ok) assert.equal(old.value.contentBase64, Buffer.from(codeBytes()).toString('base64'));

  const restored = await h.service.restore(h.owner, source.artifactId, {
    mode: 'cloud',
    version: 1,
    expectedVersion: 2,
  });
  assert.equal(restored.ok, true);
  const current = await h.service.download(h.owner, source.artifactId, { mode: 'cloud' });
  assert.equal(current.ok, true);
  if (current.ok) {
    assert.equal(current.value.contentBase64, Buffer.from(codeBytes()).toString('base64'));
  }
});

test('a tree batch rejects duplicate, case-folded and file-directory path conflicts', async () => {
  const h = artifactHarness();
  const writer = createArtifactTreeWriter({ artifacts: h.service });
  const base = {
    relativePath: 'note.txt',
    mediaType: 'text/plain' as const,
    kind: 'document' as const,
    content: textBytes('note'),
  };

  const duplicate = await writer.persist(h.owner, {
    projectId: 'proj_conflict',
    mode: 'cloud',
    files: [
      base,
      { ...base, relativePath: 'note.txt', content: textBytes('another') },
    ],
  });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.code, 'conflict');

  const caseFold = await writer.persist(h.owner, {
    projectId: 'proj_conflict',
    mode: 'cloud',
    files: [
      { ...base, relativePath: 'README.md', mediaType: 'text/markdown' as const },
      { ...base, relativePath: 'readme.md', mediaType: 'text/markdown' as const },
    ],
  });
  assert.equal(caseFold.ok, false);
  if (!caseFold.ok) assert.equal(caseFold.code, 'conflict');

  const fileAndDirectory = await writer.persist(h.owner, {
    projectId: 'proj_conflict',
    mode: 'cloud',
    files: [base, { ...base, relativePath: 'note.txt/nested.txt' }],
  });
  assert.equal(fileAndDirectory.ok, false);
  if (!fileAndDirectory.ok) assert.equal(fileAndDirectory.code, 'conflict');

  const empty = await writer.persist(h.owner, {
    projectId: 'proj_conflict',
    mode: 'cloud',
    files: [],
  });
  assert.equal(empty.ok, false);
});
