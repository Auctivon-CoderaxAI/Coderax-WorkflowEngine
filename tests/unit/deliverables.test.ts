import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ArtifactDescriptor, ArtifactUploadRequest, DataMode } from '@coderax/contracts';
import { createArtifactToolkit } from '../../src/artifacts/toolkit.js';
import { persistProduced } from '../../src/artifacts/persist.js';
import { digestOf, resolveInside } from '../../src/artifacts/file.js';
import { readZip } from '../../src/artifacts/zip.js';
import type { ArtifactService } from '../../src/artifacts/service.js';
import type { ProducedDeliverable, ResolvedBase, StagedArtifact } from '../../src/artifacts/types.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';

const toolkit = createArtifactToolkit();

type Produced = { produced: ProducedDeliverable; staging: string; bytes: Map<string, Buffer> };

/**
 * Runs the toolkit against a real, isolated staging directory and keeps the
 * verified bytes in memory so a test can inspect them before cleanup.
 */
async function produce(
  request: Record<string, unknown>,
  base?: ResolvedBase,
  options: { keepStaging?: boolean } = {},
): Promise<{ ok: true; value: Produced } | { ok: false; code: string; detail: string }> {
  const staging = mkdtempSync(path.join(tmpdir(), 'coderax-deliverable-'));
  try {
    const result = await toolkit.produce({
      request: request as never,
      context: {
        mode: (request.mode as DataMode | undefined) ?? 'cloud',
        staging,
        clock: createClock(),
        ids: createIdGenerator(),
        ...(base ? { base } : {}),
      },
    });
    if (!result.ok) return { ok: false, code: result.code, detail: result.detail };
    const bytes = new Map<string, Buffer>();
    for (const file of result.value.files) {
      bytes.set(file.filename, readFileSync(file.absolute));
    }
    return { ok: true, value: { produced: result.value, staging, bytes } };
  } finally {
    if (!options.keepStaging) rmSync(staging, { recursive: true, force: true });
  }
}

function descriptorFor(file: StagedArtifact, version = 1): ArtifactDescriptor {
  return {
    artifactId: `art_${digestOf(file.filename).slice(0, 16)}`,
    kind: file.kind,
    filename: file.filename,
    mediaType: file.mediaType,
    bytes: file.bytes,
    sha256: file.sha256,
    mode: 'cloud',
    version,
    versions: version,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    inferenceExposure: 'none',
  };
}

function stubService(input: {
  failOn?: number;
  appended?: Array<{ artifactId: string; expectedVersion?: number }>;
} = {}): ArtifactService & { uploads: ArtifactUploadRequest[]; removed: string[] } {
  let calls = 0;
  const uploads: ArtifactUploadRequest[] = [];
  const removed: string[] = [];
  const service = {
    durable: true,
    backend: 'test',
    uploads,
    removed,
    async upload(_principal: unknown, request: ArtifactUploadRequest) {
      calls += 1;
      if (input.failOn !== undefined && calls === input.failOn) {
        return { ok: false as const, code: 'quota_exceeded' as const, detail: 'quota', retryable: false };
      }
      uploads.push(request);
      const file = {
        filename: request.filename,
        bytes: Buffer.from(request.contentBase64, 'base64').length,
        sha256: digestOf(Buffer.from(request.contentBase64, 'base64')),
        kind: request.kind ?? 'document',
        mediaType: request.mediaType,
      } as StagedArtifact;
      return { ok: true as const, value: { artifact: descriptorFor(file), version: {} as never } };
    },
    async addVersion(_principal: unknown, artifactId: string, request: ArtifactUploadRequest & { expectedVersion?: number }) {
      input.appended?.push({
        artifactId,
        ...(request.expectedVersion !== undefined ? { expectedVersion: request.expectedVersion } : {}),
      });
      const file = {
        filename: request.filename,
        bytes: Buffer.from(request.contentBase64, 'base64').length,
        sha256: digestOf(Buffer.from(request.contentBase64, 'base64')),
        kind: request.kind ?? 'document',
        mediaType: request.mediaType,
      } as StagedArtifact;
      return {
        ok: true as const,
        value: { artifact: descriptorFor(file, 2), version: {} as never },
      };
    },
    async remove(_principal: unknown, artifactId: string) {
      removed.push(artifactId);
      return {
        ok: true as const,
        value: { artifactId, deletedVersions: 1, releasedBytes: 0 },
      };
    },
  };
  return service as unknown as ArtifactService & {
    uploads: ArtifactUploadRequest[];
    removed: string[];
  };
}

const principal = { ownerId: 'owner-test', isOwner: true as const };

test('a document produces real DOCX, PDF and Markdown that are read back', async () => {
  const result = await produce({
    kind: 'document',
    mode: 'cloud',
    filename: 'quarterly',
    title: 'Quarterly Review',
    subtitle: 'Q3',
    author: 'Owner',
    blocks: [
      { type: 'heading', level: 1, text: 'Results' },
      { type: 'paragraph', text: 'Revenue grew across every region this quarter.' },
      { type: 'bullets', items: ['North', 'South', 'East'] },
      { type: 'table', headers: ['Region', 'Growth'], rows: [['North', '12%'], ['South', '9%']] },
    ],
    formats: ['docx', 'pdf', 'markdown'],
  });
  assert.ok(result.ok, result.ok ? '' : result.detail);
  const { produced, bytes } = result.value;
  assert.equal(produced.kind, 'document');
  assert.equal(produced.files.length, 3);
  assert.deepEqual([...bytes.keys()].sort(), ['quarterly.docx', 'quarterly.md', 'quarterly.pdf']);
  assert.ok(bytes.get('quarterly.docx')!.subarray(0, 2).equals(Buffer.from('PK')));
  assert.ok(bytes.get('quarterly.pdf')!.subarray(0, 5).toString().startsWith('%PDF-'));
  assert.ok(bytes.get('quarterly.md')!.toString().includes('# Quarterly Review'));

  const checks = new Map(produced.checks.map((check) => [check.name, check]));
  for (const name of ['docx.structure', 'docx.headings', 'docx.tables', 'docx.text', 'pdf.structure', 'markdown.content']) {
    assert.equal(checks.get(name)?.ok, true, `${name}: ${checks.get(name)?.detail}`);
  }
  assert.equal(produced.document?.model.title, 'Quarterly Review');
  assert.equal(produced.files.filter((file) => file.format === 'docx').length, 1);
});

test('a stored document is revised by artifact id and records the versions it revises', async () => {
  const base: ResolvedBase = {
    artifactId: 'art_source_base',
    version: 4,
    model: {
      version: 1,
      title: 'Old title',
      blocks: [{ type: 'paragraph', text: 'Original body.' }],
    },
    outputs: [
      { format: 'docx', artifactId: 'art_docx', version: 3, filename: 'brief.docx' },
      { format: 'pdf', artifactId: 'art_pdf', version: 3, filename: 'brief.pdf' },
    ],
  };
  const result = await produce(
    {
      kind: 'document',
      mode: 'cloud',
      filename: 'brief',
      title: 'New title',
      blocks: [],
      formats: ['docx', 'pdf'],
      edits: [{ op: 'append', blocks: [{ type: 'paragraph', text: 'Added later.' }] }],
    },
    base,
  );
  assert.ok(result.ok, result.ok ? '' : result.detail);
  const { produced } = result.value;
  assert.equal(produced.document?.model.title, 'New title');
  assert.equal(produced.document?.model.blocks.length, 2);
  assert.deepEqual(produced.document?.versionOf, {
    artifactId: 'art_source_base',
    expectedVersion: 4,
  });
  for (const file of produced.files) {
    assert.ok(file.versionOf, `${file.filename} must revise an existing artifact`);
  }
  assert.equal(produced.files.find((file) => file.format === 'docx')?.filename, 'brief.docx');
});

test('a document with neither blocks nor a base artifact is refused', async () => {
  const result = await produce({
    kind: 'document',
    filename: 'empty',
    title: 'Empty',
    blocks: [],
    formats: ['docx'],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'validation_failed');
});

test('a workbook contains native chart parts, formulas and structured tables', async () => {
  const result = await produce({
    kind: 'spreadsheet',
    filename: 'sales',
    title: 'Sales',
    sheets: [
      {
        name: 'Data',
        columns: [
          { header: 'Month', type: 'text' },
          { header: 'Revenue', type: 'number', total: true },
        ],
        rows: [
          ['Jan', 100],
          ['Feb', 150],
        ],
        formulas: [{ cell: 'B4', formula: 'SUM(B2:B3)' }],
        charts: [
          {
            type: 'bar',
            title: 'Revenue by month',
            categories: ['Jan', 'Feb'],
            series: [{ name: 'Revenue', values: [100, 150] }],
          },
        ],
      },
    ],
  });
  assert.ok(result.ok, result.ok ? '' : result.detail);
  const { produced, bytes } = result.value;
  const workbook = bytes.get('sales.xlsx')!;
  const parts = readZip(workbook);
  assert.ok(parts.has('xl/charts/chart1.xml'), 'a native chart part is present');
  assert.ok(parts.has('xl/tables/table1.xml'), 'a structured table part is present');
  assert.ok(parts.get('xl/worksheets/sheet1.xml')!.toString().includes('<f>SUM(B2:B3)</f>'));
  const checks = new Map(produced.checks.map((check) => [check.name, check]));
  assert.equal(checks.get('xlsx.reopen')?.ok, true, checks.get('xlsx.reopen')?.detail);
  assert.equal(checks.get('xlsx.charts')?.ok, true);
});

test('a presentation has editable slides, charts and speaker notes', async () => {
  const result = await produce({
    kind: 'presentation',
    filename: 'deck',
    title: 'Roadmap',
    slides: [
      { layout: 'title', title: 'Roadmap', subtitle: 'Next year' },
      {
        layout: 'content',
        title: 'Growth',
        bullets: ['Ship', 'Measure'],
        notes: 'Speak to the retention curve.',
      },
      {
        layout: 'content',
        title: 'Trend',
        chart: {
          type: 'line',
          title: 'Users',
          categories: ['Q1', 'Q2'],
          series: [{ name: 'Users', values: [10, 20] }],
        },
      },
    ],
  });
  assert.ok(result.ok, result.ok ? '' : result.detail);
  const { produced, bytes } = result.value;
  const deck = readZip(bytes.get('deck.pptx')!);
  assert.ok(deck.has('ppt/slides/slide1.xml'));
  assert.ok(deck.has('ppt/slides/slide3.xml'));
  assert.ok(deck.has('ppt/notesSlides/notesSlide2.xml'));
  assert.ok(deck.has('ppt/charts/chart1.xml'));
  const checks = new Map(produced.checks.map((check) => [check.name, check]));
  assert.equal(checks.get('pptx.reopen')?.ok, true, checks.get('pptx.reopen')?.detail);
});

test('a CSV dataset is transformed, profiled and exported reproducibly', async () => {
  const result = await produce({
    kind: 'dataset',
    filename: 'orders',
    source: { format: 'csv', text: 'region,amount\nnorth,10\nsouth,20\nnorth,40\n' },
    steps: [{ op: 'groupBy', columns: ['region'], aggregates: [{ column: 'amount', fn: 'sum', as: 'total' }] }],
    exports: ['json', 'csv', 'tsv', 'xlsx'],
  });
  assert.ok(result.ok, result.ok ? '' : result.detail);
  const { produced, bytes } = result.value;
  assert.equal(produced.analysis?.rowsIn, 3);
  assert.equal(produced.analysis?.rowsOut, 2);
  assert.equal(produced.analysis?.sourceFormat, 'csv');
  assert.ok(bytes.has('orders.recipe.json'));
  assert.ok(bytes.has('orders.tsv'));
  const recipe = JSON.parse(bytes.get('orders.recipe.json')!.toString()) as { source: { digest: string }; steps: unknown[] };
  assert.equal(recipe.source.digest, produced.analysis?.sourceDigest);
  assert.equal(recipe.steps.length, 1);
  const tsv = bytes.get('orders.tsv')!.toString().split('\n')[0];
  assert.ok(tsv.includes('\t'), 'a TSV export uses tab separators');
});

test('a TSV dataset is ingested with tab delimiters', async () => {
  const result = await produce({
    kind: 'dataset',
    filename: 'metrics',
    source: { format: 'tsv', text: 'name\tvalue\nalpha\t1\nbeta\t2\n' },
    exports: ['json'],
  });
  assert.ok(result.ok, result.ok ? '' : result.detail);
  assert.equal(result.value.produced.analysis?.sourceFormat, 'tsv');
  assert.equal(result.value.produced.analysis?.rowsOut, 2);
  assert.equal(result.value.produced.analysis?.profile.columns, 2);
});

test('a software tree is flattened into unique artifact names and parsed, never executed', async () => {
  const result = await produce({
    kind: 'software',
    name: 'demo',
    description: 'A small module.',
    template: 'module',
    language: 'javascript',
    files: [],
  });
  assert.ok(result.ok, result.ok ? '' : result.detail);
  const { produced, bytes } = result.value;
  assert.ok(produced.project);
  assert.equal(produced.project?.verification.executed, false);
  const names = produced.files.map((file) => file.filename);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, names.length);
  for (const name of names) {
    assert.ok(!name.includes('/'), `${name} must be flat`);
    assert.ok(name.length <= 200);
  }
  assert.ok(produced.files.every((file) => file.projectPath), 'each file keeps its project path');
  assert.ok([...bytes.values()].some((body) => body.toString().includes('export function')));
  assert.ok(produced.checks.some((check) => check.name === 'entry' && check.ok));
});

test('a software tree cannot carry a parent-relative path', async () => {
  const result = await produce({
    kind: 'software',
    name: 'escape',
    description: 'attempts traversal',
    files: [{ path: '../outside.js', content: 'export {};\n' }],
  });
  assert.equal(result.ok, false);
});

test('staging paths cannot escape the staging root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-confine-'));
  try {
    assert.throws(() => resolveInside(root, '../escape.txt'));
    assert.throws(() => resolveInside(root, '/etc/passwd'));
    assert.throws(() => resolveInside(root, 'a/../../b'));
    assert.ok(resolveInside(root, 'nested/file.txt').startsWith(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistence stores every verified file and composes a document source that names them', async () => {
  const produced = await produce({
    kind: 'document',
    filename: 'memo',
    title: 'Memo',
    blocks: [{ type: 'paragraph', text: 'Body text.' }],
    formats: ['docx', 'markdown'],
  }, undefined, { keepStaging: true });
  assert.ok(produced.ok, produced.ok ? '' : produced.detail);
  const service = stubService();
  const stored = await persistProduced({
    artifacts: service,
    principal,
    mode: 'cloud',
    produced: produced.value.produced,
    note: 'deliverable:document',
  });
  assert.ok(stored.ok, stored.ok ? '' : stored.detail);
  assert.equal(stored.value.descriptors.length, 3);
  assert.equal(stored.value.source?.format, 'document.json');
  const sourceUpload = service.uploads.find((upload) => upload.filename === 'memo.document.json');
  assert.ok(sourceUpload, 'the editable source is stored');
  const body = JSON.parse(Buffer.from(sourceUpload.contentBase64, 'base64').toString()) as {
    document: { title: string };
    outputs: Array<{ format: string; artifactId: string }>;
  };
  assert.equal(body.document.title, 'Memo');
  assert.deepEqual(body.outputs.map((entry) => entry.format).sort(), ['docx', 'markdown']);
  assert.ok(body.outputs.every((entry) => entry.artifactId.startsWith('art_')));
});

test('a failed persistence rolls back the artifacts it created', async () => {
  const produced = await produce({
    kind: 'document',
    filename: 'rollback',
    title: 'Rollback',
    blocks: [{ type: 'paragraph', text: 'Body.' }],
    formats: ['docx', 'pdf', 'markdown'],
  }, undefined, { keepStaging: true });
  assert.ok(produced.ok, produced.ok ? '' : produced.detail);
  const service = stubService({ failOn: 2 });
  const stored = await persistProduced({
    artifacts: service,
    principal,
    mode: 'cloud',
    produced: produced.value.produced,
    note: 'deliverable:document',
  });
  assert.equal(stored.ok, false);
  if (!stored.ok) assert.equal(stored.code, 'quota_exceeded');
  assert.equal(service.uploads.length, 1);
  assert.equal(service.removed.length, 1, 'the first artifact was removed again');
});
