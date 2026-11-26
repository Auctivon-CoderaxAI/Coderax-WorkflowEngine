import {
  DeliverableRequest,
  StoredDocument,
  type ArtifactDescriptor,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactMediaType,
  type ChartSpec,
  type DatasetAnalysis,
  type DatasetRequest,
  type Deliverable,
  type DocumentRequest,
  type PresentationRequest,
  type SheetRequest,
  type SoftwareRequest,
  type SpreadsheetRequest,
} from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type {
  ArtifactToolkit,
  CheckList,
  ProduceInput,
  ToolkitContext,
} from './types.js';
import { checksPass, runFolder } from './types.js';
import { ArtifactPathError, digestOf, readArtifact, writeArtifact } from './file.js';
import {
  analyzeDocx,
  applyDocumentEdits,
  documentText,
  renderDocx,
  renderDocumentPdf,
  renderHtml,
  renderMarkdown,
  summarizeExtractively,
  type DocumentModel,
} from './document.js';
import { renderPdf, verifyPdf, type PdfBlock } from './pdf.js';
import { renderWorkbook, validateChart, verifyWorkbook } from './workbook.js';
import { renderPresentation, verifyPresentation } from './deck.js';
import {
  applySteps,
  parseDataset,
  profileDataset,
  recipeFor,
  tableRowsForSheet,
  toCsv,
  type DataTable,
} from './data.js';
import { buildSoftware, PermissionError } from './software.js';
import { manifestFor } from './tree.js';
import { inspectImage } from './image.js';

/**
 * One toolkit, invoked from two places: an owner-initiated API call and a
 * Coderax Native task. It writes only inside the confined workspace it is given,
 * asks the injected authorization port before creating a deliverable folder, and
 * records a receipt for both outcomes. It owns no task state and starts no run.
 */

const MEDIA_TYPES: Record<ArtifactFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  source: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
};

type EmitInput = {
  context: ToolkitContext;
  folder: string;
  name: string;
  data: Buffer | string;
  kind: ArtifactKind;
  format: ArtifactFormat;
  title: string;
};

async function emit(input: EmitInput): Promise<ArtifactDescriptor> {
  const written = await writeArtifact({
    root: input.context.root,
    relative: `${input.folder}/${input.name}`,
    data: input.data,
  });
  // The workspace copy exists only so the writer can read its own output back.
  // Durability starts here: no descriptor, no deliverable.
  return input.context.persist({
    filename: input.name,
    mediaType: durableMediaType(input.format),
    data: input.data,
    title: input.title,
    sha256: written.digest,
  });
}

/**
 * Durable storage accepts only inert media. Generated HTML is stored as plain
 * text so a download is never rendered as active content, and structured text
 * drops its charset parameter to match the published enum.
 */
function durableMediaType(format: ArtifactFormat): ArtifactMediaType {
  const base = MEDIA_TYPES[format].split(';')[0] ?? 'text/plain';
  if (base === 'text/html') return 'text/plain';
  return base as ArtifactMediaType;
}

async function authorizeFolder(context: ToolkitContext, folder: string): Promise<void> {
  const allowed = await context.authorize({ mode: context.mode, relativePath: folder });
  if (!allowed) {
    throw new PermissionError('Writing this deliverable was not authorized.');
  }
}

function finish(input: {
  request: DeliverableRequest;
  context: ToolkitContext;
  title: string;
  summary: string;
  artifacts: ArtifactDescriptor[];
  checks: CheckList;
  analysis?: DatasetAnalysis;
  inspection?: Deliverable['inspection'];
}): ServiceResult<Deliverable> {
  const verification = { ok: checksPass(input.checks), checks: input.checks };
  if (!verification.ok) {
    input.context.receipts({
      action: 'deliverable.refused',
      outcome: 'refused',
      detail: `${input.request.kind} failed verification`,
    });
    const firstFailure = input.checks.find((check) => !check.ok);
    return fail(
      'internal_error',
      `The ${input.request.kind} did not pass objective verification: ${firstFailure?.detail ?? 'unknown check failed'}`,
    );
  }
  const receipt = input.context.receipts({
    action: 'deliverable.created',
    outcome: 'completed',
    detail: `${input.request.kind} ${input.artifacts.length} artifact(s) ${input.artifacts[0]?.sha256 ?? ''}`,
  });
  return ok({
    kind: input.request.kind === 'media' ? 'image' : input.request.kind,
    title: input.title.slice(0, 200),
    summary: input.summary.slice(0, 4000),
    artifacts: input.artifacts,
    verification,
    receipt: { receiptId: receipt.receipt, at: receipt.at },
    ...(input.analysis ? { analysis: input.analysis } : {}),
    ...(input.inspection ? { inspection: input.inspection } : {}),
  });
}

async function loadDocumentModel(
  request: DocumentRequest,
  context: ToolkitContext,
): Promise<DocumentModel> {
  if (!request.base && request.blocks.length === 0) {
    throw new RangeError('A document needs blocks, or a base document to edit.');
  }
  if (request.base && request.blocks.length > 0) {
    throw new RangeError('Send either blocks or a base document with edits, not both.');
  }
  let model: DocumentModel;
  if (request.base) {
    const raw = JSON.parse(
      (await readArtifact({ root: context.root, relative: request.base, limit: 2 * 1024 * 1024 })).toString('utf8'),
    ) as unknown;
    const parsed = StoredDocument.safeParse(raw);
    if (!parsed.success) {
      throw new RangeError('The base document is not a document model this engine produced.');
    }
    model = { ...parsed.data, title: request.title, ...(request.subtitle ? { subtitle: request.subtitle } : {}) };
  } else {
    model = {
      version: 1,
      title: request.title,
      ...(request.subtitle ? { subtitle: request.subtitle } : {}),
      ...(request.author ? { author: request.author } : {}),
      blocks: request.blocks,
    };
  }
  model = applyDocumentEdits(model, request.edits);
  return model;
}

async function produceDocument(
  request: DocumentRequest,
  context: ToolkitContext,
): Promise<ServiceResult<Deliverable>> {
  const model = await loadDocumentModel(request, context);
  const folder = runFolder({ clock: context.clock, slug: request.filename });
  await authorizeFolder(context, folder);

  const artifacts: ArtifactDescriptor[] = [];
  const checks: CheckList = [];
  const expectedHeadings = model.blocks.filter((block) => block.type === 'heading').length;
  const expectedTables = model.blocks.filter((block) => block.type === 'table').length;

  const modelJson = `${JSON.stringify(model, null, 2)}\n`;
  const modelArtifact = await emit({
    context,
    folder,
    name: `${request.filename}.document.json`,
    data: modelJson,
    kind: 'document',
    format: 'json',
    title: `${model.title} (editable model)`,
  });
  artifacts.push(modelArtifact);

  if (request.formats.includes('docx')) {
    const docx = await renderDocx(model);
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.docx`,
        data: docx,
        kind: 'document',
        format: 'docx',
        title: model.title,
      }),
    );
    try {
      const analysis = analyzeDocx(docx);
      checks.push({
        name: 'docx.structure',
        ok: analysis.paragraphs.length > 0,
        detail: `${analysis.paragraphs.length} paragraphs and ${analysis.tableCount} tables read back from the DOCX.`,
      });
      checks.push({
        name: 'docx.headings',
        ok: analysis.headings.length === expectedHeadings,
        detail: `Expected ${expectedHeadings} headings, read ${analysis.headings.length}.`,
      });
      checks.push({
        name: 'docx.tables',
        ok: analysis.tableCount === expectedTables,
        detail: `Expected ${expectedTables} tables, read ${analysis.tableCount}.`,
      });
      checks.push({
        name: 'docx.text',
        ok: analysis.wordCount > 0 && analysis.paragraphs.some((paragraph) => paragraph.text === model.title),
        detail: `${analysis.wordCount} words and the document title were read back.`,
      });
    } catch (error) {
      checks.push({
        name: 'docx.structure',
        ok: false,
        detail: error instanceof Error ? error.message : 'The DOCX could not be read back.',
      });
    }
  }

  if (request.formats.includes('pdf')) {
    const pdf = await renderDocumentPdf(model);
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.pdf`,
        data: pdf,
        kind: 'document',
        format: 'pdf',
        title: model.title,
      }),
    );
    const verified = verifyPdf(pdf);
    checks.push({ name: 'pdf.structure', ok: verified.ok, detail: verified.detail });
  }

  if (request.formats.includes('markdown')) {
    const markdown = renderMarkdown(model);
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.md`,
        data: markdown,
        kind: 'document',
        format: 'markdown',
        title: model.title,
      }),
    );
    checks.push({
      name: 'markdown.content',
      ok: markdown.includes(model.title) && markdown.length > model.title.length,
      detail: `${markdown.length} characters of Markdown include the title.`,
    });
  }

  if (request.formats.includes('html')) {
    const html = renderHtml(model);
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.html`,
        data: html,
        kind: 'document',
        format: 'html',
        title: model.title,
      }),
    );
    checks.push({
      name: 'html.content',
      ok: html.includes('<html') && html.includes(model.title.replace(/&/g, '&amp;')),
      detail: 'The HTML has a document shell and the title.',
    });
  }

  const words = documentText(model).split(/\s+/).filter(Boolean).length;
  const extract = summarizeExtractively(documentText(model));
  const summary = `${model.title}: ${words} words across ${model.blocks.length} blocks. ${
    extract.length > 0 ? `Extractive summary: ${extract}` : ''
  }`.trim();

  return finish({
    request,
    context,
    title: model.title,
    summary,
    artifacts,
    checks: [
      { name: 'document.source', ok: true, detail: 'The editable model was persisted beside the artifacts.' },
      ...checks,
    ],
  });
}

function sourceModel<T extends object>(request: T): string {
  const { mode: _mode, ...rest } = request as T & { mode?: string };
  return `${JSON.stringify(rest, null, 2)}\n`;
}

async function produceSpreadsheet(
  request: SpreadsheetRequest,
  context: ToolkitContext,
): Promise<ServiceResult<Deliverable>> {
  const build = await renderWorkbook(request);
  const folder = runFolder({ clock: context.clock, slug: request.filename });
  await authorizeFolder(context, folder);

  const artifacts: ArtifactDescriptor[] = [];
  artifacts.push(
    await emit({
      context,
      folder,
      name: `${request.filename}.xlsx`,
      data: build.buffer,
      kind: 'spreadsheet',
      format: 'xlsx',
      title: request.title,
    }),
  );
  artifacts.push(
    await emit({
      context,
      folder,
      name: `${request.filename}.workbook.json`,
      data: sourceModel(request),
      kind: 'spreadsheet',
      format: 'json',
      title: `${request.title} (source model)`,
    }),
  );

  const verification = await verifyWorkbook(build.buffer, request);
  const checks: CheckList = [
    { name: 'xlsx.reopen', ok: verification.ok, detail: verification.detail },
    {
      name: 'xlsx.charts',
      ok: build.charts === request.sheets.reduce((total, sheet) => total + sheet.charts.length, 0),
      detail: `${build.charts} worksheet charts requested and written as native chart parts.`,
    },
    {
      name: 'xlsx.formulas',
      ok: build.formulas >= request.sheets.reduce((total, sheet) => total + sheet.formulas.length, 0),
      detail: `${build.formulas} formulas and totals written; every declared formula was reloaded.`,
    },
  ];

  const rows = request.sheets.reduce((total, sheet) => total + sheet.rows.length, 0);
  return finish({
    request,
    context,
    title: request.title,
    summary: `${request.sheets.length} worksheets, ${rows} data rows, ${build.formulas} formulas, ${build.tables} structured tables and ${build.charts} charts.`,
    artifacts,
    checks,
  });
}

async function producePresentation(
  request: PresentationRequest,
  context: ToolkitContext,
): Promise<ServiceResult<Deliverable>> {
  const buffer = await renderPresentation(request);
  const folder = runFolder({ clock: context.clock, slug: request.filename });
  await authorizeFolder(context, folder);

  const artifacts: ArtifactDescriptor[] = [];
  artifacts.push(
    await emit({
      context,
      folder,
      name: `${request.filename}.pptx`,
      data: buffer,
      kind: 'presentation',
      format: 'pptx',
      title: request.title,
    }),
  );
  artifacts.push(
    await emit({
      context,
      folder,
      name: `${request.filename}.deck.json`,
      data: sourceModel(request),
      kind: 'presentation',
      format: 'json',
      title: `${request.title} (source model)`,
    }),
  );

  const verification = verifyPresentation(buffer, request);
  const checks: CheckList = [
    { name: 'pptx.reopen', ok: verification.ok, detail: verification.detail },
  ];
  return finish({
    request,
    context,
    title: request.title,
    summary: `${request.slides.length} editable slides with ${
      request.slides.filter((slide) => slide.chart).length
    } charts, ${request.slides.filter((slide) => slide.table).length} tables and ${
      request.slides.filter((slide) => slide.notes).length
    } speaker-note pages.`,
    artifacts,
    checks,
  });
}

function datasetSheets(input: {
  request: DatasetRequest;
  table: DataTable;
  profile: ReturnType<typeof profileDataset>;
  applied: string[];
}): SheetRequest[] {
  const dataColumns = input.table.columns.map((name) => {
    const field = input.profile.fields.find((entry) => entry.name === name);
    return {
      header: name,
      type: field?.type === 'number' ? ('number' as const) : field?.type === 'date' ? ('date' as const) : ('text' as const),
      width: Math.min(40, Math.max(12, name.length + 4)),
      total: false,
    };
  });
  const column = (
    header: string,
    type: 'text' | 'number' | 'date' | 'currency' | 'percent',
  ): SheetRequest['columns'][number] => ({ header, type, total: false });
  const profileColumns = [
    column('Field', 'text'),
    column('Type', 'text'),
    column('Missing', 'number'),
    column('Unique', 'number'),
    column('Min', 'number'),
    column('Max', 'number'),
    column('Mean', 'number'),
    column('Median', 'number'),
    column('Std dev', 'number'),
  ];
  const recipeColumns = [column('Step', 'number'), column('Transformation', 'text')];
  return [
    {
      name: 'Data',
      columns: dataColumns,
      rows: tableRowsForSheet(input.table),
      formulas: [],
      table: true,
      charts: input.request.charts,
      freezeHeader: true,
    },
    {
      name: 'Profile',
      columns: profileColumns,
      rows: input.profile.fields.map((field) => [
        field.name,
        field.type,
        field.missing,
        field.unique,
        field.min ?? null,
        field.max ?? null,
        field.mean ?? null,
        field.median ?? null,
        field.stdev ?? null,
      ]),
      formulas: [],
      table: true,
      charts: [],
      freezeHeader: true,
    },
    {
      name: 'Recipe',
      columns: recipeColumns,
      rows: input.applied.length > 0 ? input.applied.map((step, index) => [index + 1, step]) : [[1, 'no transformations']],
      formulas: [],
      table: true,
      charts: [],
      freezeHeader: true,
    },
  ];
}

async function produceDataset(
  request: DatasetRequest,
  context: ToolkitContext,
): Promise<ServiceResult<Deliverable>> {
  const sourceDigest = digestOf(request.source.text);
  const parsed = parseDataset(request.source.text, request.source.format);
  const rowsIn = parsed.rows.length;
  const { table, applied } = applySteps(parsed, request.steps);
  const profile = profileDataset(table);
  const recipe = recipeFor({ request, sourceDigest, applied });
  const recipeText = `${JSON.stringify(recipe, null, 2)}\n`;
  const recipeDigest = digestOf(recipeText);
  const analysis: DatasetAnalysis = {
    sourceFormat: request.source.format,
    sourceDigest,
    rowsIn,
    rowsOut: table.rows.length,
    stepsApplied: applied.map((step) => step.slice(0, 300)),
    profile,
    recipeDigest,
  };

  for (const chart of request.charts) validateChart(chart);

  const folder = runFolder({ clock: context.clock, slug: request.filename });
  await authorizeFolder(context, folder);
  const artifacts: ArtifactDescriptor[] = [];
  const checks: CheckList = [];

  const recipeArtifact = await emit({
    context,
    folder,
    name: `${request.filename}.recipe.json`,
    data: recipeText,
    kind: 'dataset',
    format: 'json',
    title: `${request.filename} reproducible recipe`,
  });
  artifacts.push(recipeArtifact);
  checks.push({
    name: 'dataset.recipe',
    ok: recipeArtifact.sha256 === digestOf(recipeText).replace(/^sha256:/, ''),
    detail: `Recipe ${recipeDigest.slice(0, 19)} persisted with ${request.steps.length} declared steps.`,
  });
  checks.push({
    name: 'dataset.rows',
    ok: analysis.rowsOut === profile.rows && profile.rows === table.rows.length,
    detail: `${rowsIn} rows in, ${table.rows.length} rows out across ${table.columns.length} columns.`,
  });

  if (request.exports.includes('json')) {
    const body = `${JSON.stringify({ analysis, recipe, rows: table.rows }, null, 2)}\n`;
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.analysis.json`,
        data: body,
        kind: 'dataset',
        format: 'json',
        title: `${request.filename} analysis`,
      }),
    );
    const reloaded = JSON.parse(body) as { rows?: unknown[] };
    checks.push({
      name: 'dataset.json',
      ok: Array.isArray(reloaded.rows) && reloaded.rows.length === table.rows.length,
      detail: 'The analysis JSON reloads with the same row count.',
    });
  }

  if (request.exports.includes('csv')) {
    const csv = toCsv(table);
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.csv`,
        data: csv,
        kind: 'dataset',
        format: 'csv',
        title: `${request.filename} cleaned data`,
      }),
    );
    const reparsed = parseDataset(csv, 'csv');
    checks.push({
      name: 'dataset.csv',
      ok: reparsed.rows.length === table.rows.length,
      detail: `The CSV round-trips ${reparsed.rows.length} rows.`,
    });
  }

  if (request.exports.includes('xlsx')) {
    const workbookRequest: SpreadsheetRequest = {
      kind: 'spreadsheet',
      mode: request.mode,
      filename: request.filename,
      title: `${request.filename} analysis`,
      sheets: datasetSheets({ request, table, profile, applied }),
    };
    const build = await renderWorkbook(workbookRequest);
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.xlsx`,
        data: build.buffer,
        kind: 'spreadsheet',
        format: 'xlsx',
        title: `${request.filename} analysis`,
      }),
    );
    const verified = await verifyWorkbook(build.buffer, workbookRequest);
    checks.push({ name: 'dataset.xlsx', ok: verified.ok, detail: verified.detail });
  }

  if (request.exports.includes('pdf')) {
    const blocks: PdfBlock[] = [
      { type: 'heading', level: 1, text: 'Dataset analysis' },
      {
        type: 'paragraph',
        text: `${rowsIn} rows read as ${request.source.format.toUpperCase()}, ${table.rows.length} rows after ${applied.length} transformation(s). Source digest ${sourceDigest.slice(0, 19)}.`,
      },
      { type: 'heading', level: 2, text: 'Fields' },
      {
        type: 'table',
        headers: ['Field', 'Type', 'Missing', 'Unique', 'Mean', 'Median', 'Std dev'],
        rows: profile.fields.map((field) => [
          field.name,
          field.type,
          String(field.missing),
          String(field.unique),
          field.mean === undefined ? '' : field.mean.toFixed(3),
          field.median === undefined ? '' : field.median.toFixed(3),
          field.stdev === undefined ? '' : field.stdev.toFixed(3),
        ]),
      },
      { type: 'heading', level: 2, text: 'Sample' },
      {
        type: 'table',
        headers: table.columns.slice(0, 8),
        rows: table.rows
          .slice(0, 20)
          .map((row) => table.columns.slice(0, 8).map((column) => String(row[column] ?? ''))),
      },
      ...request.charts.map((chart: ChartSpec) => ({
        type: 'chart' as const,
        chart,
      })),
    ];
    const pdf = await renderPdf({ title: `${request.filename} dataset analysis`, blocks });
    artifacts.push(
      await emit({
        context,
        folder,
        name: `${request.filename}.pdf`,
        data: pdf,
        kind: 'dataset',
        format: 'pdf',
        title: `${request.filename} dataset report`,
      }),
    );
    const verified = verifyPdf(pdf);
    checks.push({ name: 'dataset.pdf', ok: verified.ok, detail: verified.detail });
  }

  const summary = `Analyzed ${rowsIn} rows into ${table.rows.length} rows and ${table.columns.length} columns. ${
    applied.length > 0 ? `${applied.length} transformation(s) applied. ` : ''
  }${profile.fields.filter((field) => field.type === 'number').length} numeric field(s), ${
    profile.duplicateRows
  } duplicate row(s).`;

  return finish({
    request,
    context,
    title: `${request.filename} dataset`,
    summary,
    artifacts,
    checks,
    analysis,
  });
}

async function produceSoftware(
  request: SoftwareRequest,
  context: ToolkitContext,
): Promise<ServiceResult<Deliverable>> {
  const folder = runFolder({ clock: context.clock, slug: request.name });
  const build = await buildSoftware({
    request,
    root: context.root,
    folder,
    authorize: async (relative) => context.authorize({ mode: context.mode, relativePath: relative }),
  });

  // A source tree is a project: every file keeps its validated relativePath and
  // shares one projectId, so the durable service can reconstruct it by artifact
  // identity without ever seeing a workspace path.
  const projectId = `proj_${context.ids.artifactId()}`;
  const relativeOf = (filePath: string): string => filePath.slice(folder.length + 1);
  const treeFiles: Array<{ relativePath: string; descriptor: ArtifactDescriptor }> = [];
  for (const file of build.files) {
    const relativePath = relativeOf(file.path);
    // The manifest is regenerated after every descriptor exists.
    if (relativePath === 'MANIFEST.json') continue;
    const content = await readArtifact({ root: context.root, relative: file.path, limit: 2 * 1024 * 1024 });
    const descriptor = await context.persist({
      filename: relativePath.split('/').at(-1) as string,
      relativePath,
      projectId,
      mediaType: relativePath.endsWith('.json')
        ? 'application/json'
        : relativePath.endsWith('.md')
          ? 'text/markdown'
          : 'text/plain',
      kind: 'software',
      data: content,
      title: relativePath,
      sha256: file.digest,
    });
    treeFiles.push({ relativePath, descriptor });
  }
  const manifest = manifestFor({
    projectId,
    name: request.name,
    entry: relativeOf(build.entry),
    createdAt: context.clock.iso(),
    artifacts: treeFiles,
  });
  const manifestDescriptor = await context.persist({
    filename: 'MANIFEST.json',
    relativePath: 'MANIFEST.json',
    projectId,
    mediaType: 'application/json',
    kind: 'software',
    data: `${JSON.stringify(manifest, null, 2)}\n`,
    title: `${request.name} tree manifest`,
  });
  const artifacts: ArtifactDescriptor[] = [
    ...treeFiles.map((entry) => entry.descriptor),
    manifestDescriptor,
  ];

  const checks: CheckList = build.checks;
  const syntaxChecks = checks.filter((check) => check.name.startsWith('syntax:'));
  const summary = `${request.name}: ${build.files.length} files written (${
    request.language
  }), ${syntaxChecks.filter((check) => check.ok).length}/${syntaxChecks.length} source files parsed and every relative import resolved. The generated program was not executed.`;

  return finish({
    request,
    context,
    title: request.name,
    summary,
    artifacts,
    checks,
  });
}

async function produceMedia(
  request: Extract<DeliverableRequest, { kind: 'media' }>,
  context: ToolkitContext,
): Promise<ServiceResult<Deliverable>> {
  const data = Buffer.from(request.data, 'base64');
  if (data.length === 0) throw new RangeError('The image payload is empty.');
  if (data.length > 700_000) throw new RangeError('The image payload exceeds the inspection limit.');
  const inspection = inspectImage(data);
  const folder = runFolder({ clock: context.clock, slug: request.filename });
  await authorizeFolder(context, folder);

  const report = `${JSON.stringify(
    { inspection, sourceDigest: digestOf(data), method: 'header-only' },
    null,
    2,
  )}\n`;
  const artifact = await emit({
    context,
    folder,
    name: `${request.filename}.inspection.json`,
    data: report,
    kind: 'image',
    format: 'json',
    title: `${request.filename} inspection`,
  });

  const checks: CheckList = [
    {
      name: 'media.header',
      ok: inspection.format.length > 0,
      detail: `${inspection.format} header read as ${inspection.mediaType}, ${inspection.bytes} bytes.`,
    },
    {
      name: 'media.bytes',
      ok: inspection.bytes === data.length,
      detail: 'The reported byte count equals the decoded payload.',
    },
  ];
  if (inspection.dimensions) {
    checks.push({
      name: 'media.dimensions',
      ok: inspection.dimensions.width > 0 && inspection.dimensions.height > 0,
      detail: `${inspection.dimensions.width}x${inspection.dimensions.height} pixels from the header.`,
    });
  }

  return finish({
    request,
    context,
    title: `${request.filename} (${inspection.format})`,
    summary: `${inspection.mediaType}, ${inspection.bytes} bytes${
      inspection.dimensions
        ? `, ${inspection.dimensions.width}x${inspection.dimensions.height} pixels`
        : ''
    }. Header inspection only; no model inference.`,
    artifacts: [artifact],
    checks,
    inspection,
  });
}

export function createArtifactToolkit(): ArtifactToolkit {
  return {
    produce: async ({ request, context }: ProduceInput): Promise<ServiceResult<Deliverable>> => {
      // The HTTP router validates first, but Coderax Native can call the toolkit
      // directly, so defaults and strictness are applied at this boundary too.
      const parsed = DeliverableRequest.safeParse(request);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'request';
        return fail('validation_failed', `${where}: ${issue?.message ?? 'invalid deliverable request'}`);
      }
      const normalised = parsed.data;
      try {
        switch (normalised.kind) {
          case 'document':
            return await produceDocument(normalised, context);
          case 'spreadsheet':
            return await produceSpreadsheet(normalised, context);
          case 'presentation':
            return await producePresentation(normalised, context);
          case 'dataset':
            return await produceDataset(normalised, context);
          case 'software':
            return await produceSoftware(normalised, context);
          case 'media':
            return await produceMedia(normalised, context);
        }
      } catch (error) {
        if (error instanceof PermissionError) {
          context.receipts({
            action: 'deliverable.refused',
            outcome: 'refused',
            detail: `${normalised.kind} write refused by policy`,
          });
          return fail('permission_required', error.message);
        }
        if (error instanceof ArtifactPathError || error instanceof RangeError) {
          context.receipts({
            action: 'deliverable.refused',
            outcome: 'refused',
            detail: `${normalised.kind} rejected: ${error.message.slice(0, 200)}`,
          });
          return fail('validation_failed', error.message);
        }
        context.receipts({
          action: 'deliverable.refused',
          outcome: 'refused',
          detail: `${normalised.kind} failed to render`,
        });
        return fail(
          'internal_error',
          'The deliverable could not be produced from that request.',
        );
      }
    },
  };
}

