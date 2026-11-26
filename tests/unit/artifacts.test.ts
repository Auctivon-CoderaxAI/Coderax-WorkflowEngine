import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { ArtifactToolkit, ToolkitContext } from '../../src/artifacts/types.js';
import { createArtifactToolkit } from '../../src/artifacts/toolkit.js';
import { createClock, createIdGenerator } from '../../src/support/clock.js';
import { analyzeDocx } from '../../src/artifacts/document.js';
import type { DeliverableRequestInput } from '@coderax/contracts';

function workspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 'coderax-artifacts-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function context(root: string, overrides: Partial<ToolkitContext> = {}): ToolkitContext {
  return {
    mode: 'cloud',
    root,
    clock: createClock(),
    ids: createIdGenerator(),
    authorize: () => true,
    receipts: () => ({ receipt: 'receipt-test', at: '2026-01-01T00:00:00.000Z' }),
    ...overrides,
  };
}

async function produce(
  toolkit: ArtifactToolkit,
  root: string,
  request: DeliverableRequestInput,
  overrides: Partial<ToolkitContext> = {},
) {
  return toolkit.produce({ request, context: context(root, overrides) });
}

test('a document is written as DOCX and PDF and read back for verification', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const result = await produce(toolkit, space.root, {
      kind: 'document',
      mode: 'cloud',
      filename: 'brief',
      title: 'Product brief',
      subtitle: 'Verified output',
      author: 'Coderax',
      formats: ['docx', 'pdf', 'markdown', 'html'],
      blocks: [
        { type: 'heading', level: 1, text: 'Context' },
        { type: 'paragraph', text: 'The engine writes real office files rather than rendered HTML.' },
        { type: 'bullets', items: ['One', 'Two'] },
        { type: 'table', headers: ['Metric', 'Value'], rows: [['Latency', '12ms']] },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.value.verification.ok, true);
    const formats = result.value.artifacts.map((artifact) => artifact.format);
    assert.deepEqual(formats.sort(), ['docx', 'html', 'json', 'markdown', 'pdf']);

    const docx = result.value.artifacts.find((artifact) => artifact.format === 'docx');
    assert.ok(docx);
    const absolute = path.join(space.root, docx.path);
    assert.equal(existsSync(absolute), true);
    const analysis = analyzeDocx(readFileSync(absolute));
    assert.ok(analysis.headings.includes('Context'));
    assert.equal(analysis.tableCount, 1);
    assert.equal(docx.digest, result.value.artifacts.find((a) => a.format === 'docx')?.digest);
    assert.match(docx.digest ?? '', /^sha256:[0-9a-f]{64}$/);
  } finally {
    space.cleanup();
  }
});

test('a document model can be edited and re-rendered from the persisted source', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const first = await produce(toolkit, space.root, {
      kind: 'document',
      mode: 'cloud',
      filename: 'editable',
      title: 'First version',
      formats: ['docx'],
      blocks: [{ type: 'paragraph', text: 'Original content.' }],
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const model = first.value.artifacts.find((artifact) => artifact.path.endsWith('.document.json'));
    assert.ok(model);

    const second = await produce(toolkit, space.root, {
      kind: 'document',
      mode: 'cloud',
      filename: 'edited',
      title: 'Second version',
      formats: ['docx'],
      blocks: [],
      base: model.path,
      edits: [
        { op: 'append', blocks: [{ type: 'paragraph', text: 'Added by an edit.' }] },
        { op: 'setTitle', title: 'Second version' },
      ],
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const docx = second.value.artifacts.find((artifact) => artifact.format === 'docx');
    assert.ok(docx);
    const analysis = analyzeDocx(readFileSync(path.join(space.root, docx.path)));
    assert.ok(analysis.paragraphs.some((paragraph) => paragraph.text === 'Added by an edit.'));
    assert.ok(analysis.paragraphs.some((paragraph) => paragraph.text === 'Second version'));
  } finally {
    space.cleanup();
  }
});

test('a workbook keeps its formulas and native charts', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const result = await produce(toolkit, space.root, {
      kind: 'spreadsheet',
      mode: 'cloud',
      filename: 'forecast',
      title: 'Forecast',
      sheets: [
        {
          name: 'Revenue',
          columns: [
            { header: 'Month', type: 'text', total: false },
            { header: 'Amount', type: 'currency', total: true },
          ],
          rows: [
            ['Jan', 100],
            ['Feb', 200],
          ],
          formulas: [{ cell: 'B4', formula: 'SUM(B2:B3)' }],
          table: true,
          charts: [
            {
              type: 'bar',
              title: 'Revenue',
              categories: ['Jan', 'Feb'],
              series: [{ name: 'Amount', values: [100, 200] }],
            },
          ],
          freezeHeader: true,
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verification.ok, true);
    const xlsx = result.value.artifacts.find((artifact) => artifact.format === 'xlsx');
    assert.ok(xlsx);
    assert.equal(existsSync(path.join(space.root, xlsx.path)), true);
    assert.ok(result.value.verification.checks.some((check) => check.name === 'xlsx.charts' && check.ok));
    assert.ok(result.value.verification.checks.some((check) => check.name === 'xlsx.formulas' && check.ok));
  } finally {
    space.cleanup();
  }
});

test('a presentation is a PPTX with slides, charts and notes', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const result = await produce(toolkit, space.root, {
      kind: 'presentation',
      mode: 'cloud',
      filename: 'deck',
      title: 'Roadmap',
      slides: [
        { layout: 'title', title: 'Roadmap', subtitle: '2026', bullets: [], columns: [], flow: [] },
        {
          layout: 'content',
          title: 'Growth',
          bullets: ['One', 'Two'],
          columns: [],
          flow: [],
          chart: {
            type: 'line',
            title: 'Users',
            categories: ['Q1', 'Q2'],
            series: [{ name: 'Users', values: [10, 40] }],
          },
          notes: 'Talk to the chart.',
        },
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const pptx = result.value.artifacts.find((artifact) => artifact.format === 'pptx');
    assert.ok(pptx);
    assert.equal(existsSync(path.join(space.root, pptx.path)), true);
    assert.ok(result.value.verification.checks.some((check) => check.name === 'pptx.reopen' && check.ok));
  } finally {
    space.cleanup();
  }
});

test('a dataset analysis applies declared steps and persists a reproducible recipe', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const result = await produce(toolkit, space.root, {
      kind: 'dataset',
      mode: 'cloud',
      filename: 'orders',
      source: {
        format: 'csv',
        text: 'region,amount,units\nNorth,100,2\nSouth,250,5\nNorth,300,3\n',
      },
      steps: [
        { op: 'derive', column: 'unit_price', expression: 'amount / units' },
        {
          op: 'groupBy',
          columns: ['region'],
          aggregates: [{ column: 'amount', fn: 'sum', as: 'total' }],
        },
        { op: 'sort', column: 'total', direction: 'desc' },
      ],
      charts: [],
      exports: ['xlsx', 'csv', 'json', 'pdf'],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.analysis?.rowsIn, 3);
    assert.equal(result.value.analysis?.rowsOut, 2);
    assert.equal(result.value.verification.ok, true);

    const recipe = result.value.artifacts.find((artifact) => artifact.path.endsWith('.recipe.json'));
    assert.ok(recipe);
    const parsed = JSON.parse(readFileSync(path.join(space.root, recipe.path), 'utf8')) as {
      steps: Array<{ op: string }>;
      source: { digest: string };
    };
    assert.deepEqual(parsed.steps.map((step) => step.op), ['derive', 'groupBy', 'sort']);
    assert.match(parsed.source.digest, /^sha256:/);

    const json = result.value.artifacts.find((artifact) => artifact.path.endsWith('.analysis.json'));
    assert.ok(json);
    const analysis = JSON.parse(readFileSync(path.join(space.root, json.path), 'utf8')) as {
      rows: Array<{ region: string; total: number }>;
    };
    assert.equal(analysis.rows[0]?.region, 'North');
    assert.equal(analysis.rows[0]?.total, 400);
  } finally {
    space.cleanup();
  }
});

test('a software deliverable is parsed and its relative imports resolved', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const result = await produce(toolkit, space.root, {
      kind: 'software',
      mode: 'cloud',
      name: 'service-scaffold',
      description: 'A health-check service.',
      template: 'service',
      language: 'javascript',
      files: [],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verification.ok, true);
    assert.ok(result.value.artifacts.some((artifact) => artifact.path.endsWith('MANIFEST.json')));
    assert.ok(
      result.value.verification.checks.some(
        (check) => check.name.startsWith('syntax:src/index.js') && check.ok,
      ),
    );

    const broken = await produce(toolkit, space.root, {
      kind: 'software',
      mode: 'cloud',
      name: 'broken-tree',
      description: 'A tree with a missing import.',
      template: 'none',
      language: 'javascript',
      files: [
        {
          path: 'src/index.js',
          content: "import { nope } from './missing.js';\nexport const value = nope;\n",
        },
      ],
    });
    assert.equal(broken.ok, false);
    if (broken.ok) return;
    assert.equal(broken.code, 'internal_error');
    assert.match(broken.detail, /verification/i);
  } finally {
    space.cleanup();
  }
});

test('a TypeScript scaffold is parsed by the TypeScript compiler', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const result = await produce(toolkit, space.root, {
      kind: 'software',
      mode: 'cloud',
      name: 'typed-module',
      description: 'A typed module.',
      template: 'module',
      language: 'typescript',
      files: [],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const syntax = result.value.verification.checks.filter((check) => check.name.startsWith('syntax:'));
    assert.ok(syntax.length >= 2);
    assert.ok(syntax.every((check) => check.ok), syntax.map((check) => check.detail).join(' / '));
  } finally {
    space.cleanup();
  }
});

test('image inspection is real and unavailable generation is reported as unavailable', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const result = await produce(toolkit, space.root, {
      kind: 'media',
      mode: 'cloud',
      filename: 'pixel',
      action: 'inspect',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.inspection?.dimensions, { width: 1, height: 1 });
    assert.equal(result.value.inspection?.method, 'header');

    const media = toolkit.capabilities().media;
    assert.equal(media.find((entry) => entry.capability === 'image.inspect')?.available, true);
    for (const name of ['image.generate', 'image.edit', 'audio.transcribe', 'speech.synthesize', 'video.understand'] as const) {
      const capability = media.find((entry) => entry.capability === name);
      assert.equal(capability?.available, false, `${name} must not claim availability`);
      assert.equal(capability?.reason, 'not_configured');
    }
  } finally {
    space.cleanup();
  }
});

test('a base document outside the workspace and a denied write are refused', async () => {
  const space = workspace();
  try {
    const toolkit = createArtifactToolkit();
    const escaped = await produce(toolkit, space.root, {
      kind: 'document',
      mode: 'cloud',
      filename: 'escape',
      title: 'Escape',
      formats: ['docx'],
      blocks: [],
      base: '../outside.document.json',
    });
    assert.equal(escaped.ok, false);
    if (!escaped.ok) assert.equal(escaped.code, 'validation_failed');

    const denied = await produce(
      toolkit,
      space.root,
      {
        kind: 'document',
        mode: 'cloud',
        filename: 'denied',
        title: 'Denied',
        formats: ['docx'],
        blocks: [{ type: 'paragraph', text: 'Should not be written.' }],
      },
      { authorize: () => false },
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.code, 'permission_required');
    assert.equal(existsSync(path.join(space.root, 'deliverables')), false);
  } finally {
    space.cleanup();
  }
});
