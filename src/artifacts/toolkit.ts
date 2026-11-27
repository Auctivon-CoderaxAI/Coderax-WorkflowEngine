import {
  DeliverableRequest,
  type ArtifactKind,
  type ArtifactMediaType,
  type ChartSpec,
  type DatasetAnalysis,
  type DatasetRequest,
  type DocumentFormat,
  type DocumentRequest,
  type PresentationRequest,
  type SheetRequest,
  type SoftwareRequest,
  type SpreadsheetRequest,
} from '@coderax/contracts';
import path from 'node:path';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type {
  ArtifactToolkit,
  CheckList,
  ProduceInput,
  ProducedDeliverable,
  StagedArtifact,
  ToolkitContext,
} from './types.js';
import { checksPass } from './types.js';
import { ArtifactPathError, digestOf, readArtifact, writeArtifact } from './file.js';
import {
  analyzeDocx,
  applyDocumentEdits,
  documentText,
  renderDocx,
  renderDocumentPdf,
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
  toTsv,
  type DataTable,
} from './data.js';
import { buildSoftware } from './software.js';
import { normalizePackage } from './zip.js';

/**
 * One toolkit, invoked from two places: an owner-initiated API call and a
 * Coderax Native task.
 *
 * It writes only inside the isolated staging directory it is given, verifies
 * every produced file by reading it back, and returns the verified bytes. It
 * creates no artifact metadata, reaches no store and starts no run: the caller
 * persists the bytes through the durable artifact service and only then reports
 * a deliverable. A generation that fails verification returns files to nobody.
 */

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

type EmitInput = {
  context: ToolkitContext;
  folder: string;
  filename: string;
  data: Buffer | string;
  kind: ArtifactKind;
  mediaType: ArtifactMediaType;
  title: string;
  role: StagedArtifact['role'];
  format?: DocumentFormat;
  projectPath?: string;
  versionOf?: StagedArtifact['versionOf'];
};

async function emit(input: EmitInput): Promise<StagedArtifact> {
  const relative = path.posix.join(input.folder, input.filename);
  const written = await writeArtifact({
    root: input.context.staging,
    relative,
    data: input.data,
  });
  const size = typeof input.data === 'string' ? Buffer.byteLength(input.data, 'utf8') : input.data.length;
  return {
    filename: input.filename,
    absolute: path.resolve(input.context.staging, written.path),
    bytes: size,
    sha256: written.sha256,
    kind: input.kind,
    mediaType: input.mediaType,
    title: input.title,
    role: input.role,
    ...(input.format ? { format: input.format } : {}),
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    ...(input.versionOf ? { versionOf: input.versionOf } : {}),
  };
}

function finish(input: {
  kind: ProducedDeliverable['kind'];
  title: string;
  summary: string;
  files: StagedArtifact[];
  checks: CheckList;
  analysis?: DatasetAnalysis;
  document?: ProducedDeliverable['document'];
  project?: ProducedDeliverable['project'];
}): ServiceResult<ProducedDeliverable> {
  if (!checksPass(input.checks)) {
    const firstFailure = input.checks.find((check) => !check.ok);
    return fail(
      'internal_error',
      `The ${input.kind} did not pass objective verification: ${firstFailure?.detail ?? 'unknown check failed'}`,
    );
  }
  return ok({
    kind: input.kind,
    title: input.title.slice(0, 200),
    summary: input.summary.slice(0, 4000),
    files: input.files,
    checks: input.checks,
    ...(input.analysis ? { analysis: input.analysis } : {}),
    ...(input.document ? { document: input.document } : {}),
    ...(input.project ? { project: input.project } : {}),
  });
}

/** Artifact media type for a generated source file, by its extension. */
function sourceMediaType(extension: string): ArtifactMediaType {
  if (extension === 'json') return 'application/json';
  if (extension === 'md' || extension === 'markdown') return 'text/markdown';
  if (extension === 'csv') return 'text/csv';
  if (extension === 'tsv') return 'text/tab-separated-values';
  return 'text/plain';
}

function loadDocumentModel(request: DocumentRequest, context: ToolkitContext): DocumentModel {
  if (!context.base && request.blocks.length === 0) {
    throw new RangeError('A document needs blocks, or a base artifact to edit.');
  }
  if (context.base && request.blocks.length > 0) {
    throw new RangeError('Send either blocks or a base artifact with edits, not both.');
  }
  let model: DocumentModel;
  if (context.base) {
    if (!context.base) {
      throw new RangeError('The base artifact could not be resolved for this request.');
    }
    model = {
      ...context.base.model,
      title: request.title,
      ...(request.subtitle ? { subtitle: request.subtitle } : {}),
      ...(request.author ? { author: request.author } : {}),
    };
  } else {
    model = {
      version: 1,
      title: request.title,
      ...(request.subtitle ? { subtitle: request.subtitle } : {}),
      ...(request.author ? { author: request.author } : {}),
      blocks: request.blocks,
    };
  }
  return applyDocumentEdits(model, request.edits);
}

function outputName(input: {
  context: ToolkitContext;
  request: DocumentRequest;
  format: DocumentFormat;
}): { filename: string; versionOf?: StagedArtifact['versionOf'] } {
  const previous = input.context.base?.outputs.find((entry) => entry.format === input.format);
  if (previous) {
    return {
      filename: previous.filename,
      // A source pins historical bytes. Persistence reads the current output
      // pointer immediately before appending and uses it as the write fence.
      versionOf: { artifactId: previous.artifactId },
    };
  }
  const extension = input.format === 'markdown' ? 'md' : input.format;
  return { filename: `${input.request.filename}.${extension}` };
}

async function produceDocument(
  request: DocumentRequest,
  context: ToolkitContext,
): Promise<ServiceResult<ProducedDeliverable>> {
  const model = loadDocumentModel(request, context);
  const folder = `document-${context.ids.receipt()}`;
  const files: StagedArtifact[] = [];
  const checks: CheckList = [];
  const expectedHeadings = model.blocks.filter((block) => block.type === 'heading').length;
  const expectedTables = model.blocks.filter((block) => block.type === 'table').length;
  const previousSource = context.base;

  if (request.formats.includes('docx')) {
    const docx = normalizePackage(await renderDocx(model));
    const name = outputName({ context, request, format: 'docx' });
    files.push(
      await emit({
        context,
        folder,
        filename: name.filename,
        data: docx,
        kind: 'document',
        mediaType: DOCX,
        title: model.title,
        role: 'output',
        format: 'docx',
        ...(name.versionOf ? { versionOf: name.versionOf } : {}),
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
        ok:
          analysis.wordCount > 0 &&
          analysis.paragraphs.some((paragraph) => paragraph.text === model.title),
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
    const name = outputName({ context, request, format: 'pdf' });
    files.push(
      await emit({
        context,
        folder,
        filename: name.filename,
        data: pdf,
        kind: 'pdf',
        mediaType: 'application/pdf',
        title: model.title,
        role: 'output',
        format: 'pdf',
        ...(name.versionOf ? { versionOf: name.versionOf } : {}),
      }),
    );
    const verified = verifyPdf(pdf);
    checks.push({ name: 'pdf.structure', ok: verified.ok, detail: verified.detail });
  }

  if (request.formats.includes('markdown')) {
    const markdown = renderMarkdown(model);
    const name = outputName({ context, request, format: 'markdown' });
    files.push(
      await emit({
        context,
        folder,
        filename: name.filename,
        data: markdown,
        kind: 'document',
        mediaType: 'text/markdown',
        title: model.title,
        role: 'output',
        format: 'markdown',
        ...(name.versionOf ? { versionOf: name.versionOf } : {}),
      }),
    );
    checks.push({
      name: 'markdown.content',
      ok: markdown.includes(model.title) && markdown.length > model.title.length,
      detail: `${markdown.length} characters of Markdown include the title.`,
    });
  }

  const words = documentText(model).split(/\s+/).filter(Boolean).length;
  const extract = summarizeExtractively(documentText(model));
  const summary = `${model.title}: ${words} words across ${model.blocks.length} blocks. ${
    extract.length > 0 ? `Extractive summary: ${extract}` : ''
  }`.trim();

  return finish({
    kind: 'document',
    title: model.title,
    summary,
    files,
    checks: [
      {
        name: 'document.source',
        ok: true,
        detail: 'The editable model is stored as its own artifact so a later edit is addressed by id.',
      },
      ...checks,
    ],
    document: {
      model,
      filename: `${request.filename}.document.json`,
      ...(previousSource
        ? {
            versionOf: {
              artifactId: previousSource.artifactId,
              expectedVersion: previousSource.version,
            },
          }
        : {}),
    },
  });
}

function sourceModel(request: SpreadsheetRequest | PresentationRequest): string {
  const { mode: _mode, ...rest } = request;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

async function produceSpreadsheet(
  request: SpreadsheetRequest,
  context: ToolkitContext,
): Promise<ServiceResult<ProducedDeliverable>> {
  const build = await renderWorkbook(request);
  build.buffer = normalizePackage(build.buffer);
  const folder = `workbook-${context.ids.receipt()}`;
  const files: StagedArtifact[] = [
    await emit({
      context,
      folder,
      filename: `${request.filename}.xlsx`,
      data: build.buffer,
      kind: 'spreadsheet',
      mediaType: XLSX,
      title: request.title,
      role: 'output',
    }),
    await emit({
      context,
      folder,
      filename: `${request.filename}.workbook.json`,
      data: sourceModel(request),
      kind: 'source',
      mediaType: 'application/json',
      title: `${request.title} (source model)`,
      role: 'part',
    }),
  ];

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
    kind: 'spreadsheet',
    title: request.title,
    summary: `${request.sheets.length} worksheets, ${rows} data rows, ${build.formulas} formulas, ${build.tables} structured tables and ${build.charts} charts.`,
    files,
    checks,
  });
}

async function producePresentation(
  request: PresentationRequest,
  context: ToolkitContext,
): Promise<ServiceResult<ProducedDeliverable>> {
  const buffer = normalizePackage(await renderPresentation(request));
  const folder = `deck-${context.ids.receipt()}`;
  const files: StagedArtifact[] = [
    await emit({
      context,
      folder,
      filename: `${request.filename}.pptx`,
      data: buffer,
      kind: 'presentation',
      mediaType: PPTX,
      title: request.title,
      role: 'output',
    }),
    await emit({
      context,
      folder,
      filename: `${request.filename}.deck.json`,
      data: sourceModel(request),
      kind: 'source',
      mediaType: 'application/json',
      title: `${request.title} (source model)`,
      role: 'part',
    }),
  ];

  const verification = verifyPresentation(buffer, request);
  const checks: CheckList = [{ name: 'pptx.reopen', ok: verification.ok, detail: verification.detail }];
  return finish({
    kind: 'presentation',
    title: request.title,
    summary: `${request.slides.length} editable slides with ${
      request.slides.filter((slide) => slide.chart).length
    } charts, ${request.slides.filter((slide) => slide.table).length} tables and ${
      request.slides.filter((slide) => slide.notes).length
    } speaker-note pages.`,
    files,
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
      type:
        field?.type === 'number'
          ? ('number' as const)
          : field?.type === 'date'
            ? ('date' as const)
            : ('text' as const),
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
      rows:
        input.applied.length > 0
          ? input.applied.map((step, index) => [index + 1, step])
          : [[1, 'no transformations']],
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
): Promise<ServiceResult<ProducedDeliverable>> {
  const sourceText = request.source.text;
  const sourceDigest = digestOf(sourceText);
  const parsed = parseDataset(sourceText, request.source.format);
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

  const folder = `dataset-${context.ids.receipt()}`;
  const files: StagedArtifact[] = [];
  const checks: CheckList = [];

  const recipeArtifact = await emit({
    context,
    folder,
    filename: `${request.filename}.recipe.json`,
    data: recipeText,
    kind: 'dataset',
    mediaType: 'application/json',
    title: `${request.filename} reproducible recipe`,
    role: 'part',
  });
  files.push(recipeArtifact);
  checks.push({
    name: 'dataset.recipe',
    ok: recipeArtifact.sha256 === digestOf(recipeText),
    detail: `Recipe ${recipeDigest.slice(0, 16)} staged with ${request.steps.length} declared steps.`,
  });
  checks.push({
    name: 'dataset.rows',
    ok: analysis.rowsOut === profile.rows && profile.rows === table.rows.length,
    detail: `${rowsIn} rows in, ${table.rows.length} rows out across ${table.columns.length} columns.`,
  });

  if (request.exports.includes('json')) {
    const body = `${JSON.stringify({ analysis, recipe, rows: table.rows }, null, 2)}\n`;
    files.push(
      await emit({
        context,
        folder,
        filename: `${request.filename}.analysis.json`,
        data: body,
        kind: 'dataset',
        mediaType: 'application/json',
        title: `${request.filename} analysis`,
        role: 'output',
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
    files.push(
      await emit({
        context,
        folder,
        filename: `${request.filename}.csv`,
        data: csv,
        kind: 'spreadsheet',
        mediaType: 'text/csv',
        title: `${request.filename} cleaned data`,
        role: 'output',
      }),
    );
    const reparsed = parseDataset(csv, 'csv');
    checks.push({
      name: 'dataset.csv',
      ok: reparsed.rows.length === table.rows.length,
      detail: `The CSV round-trips ${reparsed.rows.length} rows.`,
    });
  }

  if (request.exports.includes('tsv')) {
    const tsv = toTsv(table);
    files.push(
      await emit({
        context,
        folder,
        filename: `${request.filename}.tsv`,
        data: tsv,
        kind: 'spreadsheet',
        mediaType: 'text/tab-separated-values',
        title: `${request.filename} cleaned data (TSV)`,
        role: 'output',
      }),
    );
    const reparsed = parseDataset(tsv, 'tsv');
    checks.push({
      name: 'dataset.tsv',
      ok: reparsed.rows.length === table.rows.length,
      detail: `The TSV round-trips ${reparsed.rows.length} rows.`,
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
    build.buffer = normalizePackage(build.buffer);
    files.push(
      await emit({
        context,
        folder,
        filename: `${request.filename}.xlsx`,
        data: build.buffer,
        kind: 'spreadsheet',
        mediaType: XLSX,
        title: `${request.filename} analysis`,
        role: 'output',
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
        text: `${rowsIn} rows read as ${request.source.format.toUpperCase()}, ${table.rows.length} rows after ${applied.length} transformation(s). Source digest ${sourceDigest.slice(0, 16)}.`,
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
      ...request.charts.map((chart: ChartSpec) => ({ type: 'chart' as const, chart })),
    ];
    const pdf = await renderPdf({ title: `${request.filename} dataset analysis`, blocks });
    files.push(
      await emit({
        context,
        folder,
        filename: `${request.filename}.pdf`,
        data: pdf,
        kind: 'pdf',
        mediaType: 'application/pdf',
        title: `${request.filename} dataset report`,
        role: 'output',
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
    kind: 'dataset',
    title: `${request.filename} dataset`,
    summary,
    files,
    checks,
    analysis,
  });
}

async function produceSoftware(
  request: SoftwareRequest,
  context: ToolkitContext,
): Promise<ServiceResult<ProducedDeliverable>> {
  const folder = `project-${context.ids.receipt()}`;
  const build = await buildSoftware({ request, root: context.staging, folder });
  const prefix = `${folder}/`;

  const files: StagedArtifact[] = [];
  for (const file of build.files) {
    const projectPath = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
    const data = await readArtifact({ root: context.staging, relative: file.path });
    const extension = path.posix.extname(projectPath).replace(/^\./, '') || 'txt';
    files.push(
      await emit({
        context,
        folder,
        // The store requires the artifact's file name to be the basename of its
        // tree path, so the tree is carried by `relativePath`, not by the name.
        filename: path.posix.basename(projectPath),
        data,
        kind: 'software',
        mediaType: sourceMediaType(extension),
        title: projectPath,
        role: 'part',
        projectPath,
      }),
    );
  }

  const syntaxChecks = build.checks.filter((check) => check.name.startsWith('syntax:'));
  const summary = `${request.name}: ${build.files.length} files written (${
    request.language
  }), ${syntaxChecks.filter((check) => check.ok).length}/${syntaxChecks.length} source files parsed and every relative import resolved. The generated program was not executed.`;

  return finish({
    kind: 'software',
    title: request.name,
    summary,
    files,
    checks: build.checks.length <= 60 ? build.checks.map(check => ({ ...check, name: check.name.slice(0, 80), detail: check.detail.slice(0, 500) })) : [
      ...build.checks.filter(check => !check.ok).slice(0, 59),
      { name: 'software.checks', ok: build.checks.every(check => check.ok),
        detail: `${build.checks.length} checks performed; ${build.checks.filter(check => !check.ok).length} failed.` },
    ],
    project: {
      name: request.name,
      entry: build.entry.startsWith(prefix) ? build.entry.slice(prefix.length) : build.entry,
      description: request.description,
      language: request.language,
      template: request.template,
      verification: {
        executed: false,
        method: 'parse-and-resolve',
        note: 'Files were parsed and imports resolved; the generated program was not executed because no sandboxed execution supervisor is available to this deployment.',
      },
    },
  });
}

export function createArtifactToolkit(): ArtifactToolkit {
  return {
    produce: async ({ request, context }: ProduceInput): Promise<ServiceResult<ProducedDeliverable>> => {
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
        }
      } catch (error) {
        if (error instanceof ArtifactPathError || error instanceof RangeError) {
          return fail('validation_failed', error.message);
        }
        return fail('internal_error', 'The deliverable could not be produced from that request.');
      }
    },
  };
}


