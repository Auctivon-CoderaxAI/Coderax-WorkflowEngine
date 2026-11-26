import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeliverableRequest,
  type DocumentRequest,
  type PresentationRequest,
  type SoftwareRequest,
  type SpreadsheetRequest,
  type VerificationCheck,
} from '@coderax/contracts';
import type { Principal } from '../security/auth.js';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import {
  analyzeDocx,
  applyDocumentEdits,
  renderDocx,
  renderDocumentPdf,
  renderMarkdown,
} from './document.js';
import { renderPresentation, verifyPresentation } from './deck.js';
import { verifyPdf } from './pdf.js';
import { buildSoftware } from './software.js';
import { createArtifactTreeWriter, type GeneratedArtifactFile, type TreeWriteResult } from './tree.js';
import { renderWorkbook, verifyWorkbook } from './workbook.js';
import type { ArtifactService } from './service.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' as const;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' as const;
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation' as const;

export type GeneratedTree = {
  kind: 'document' | 'spreadsheet' | 'presentation' | 'software';
  title: string;
  files: GeneratedArtifactFile[];
  checks: VerificationCheck[];
};

export type GenerationInput = {
  projectId: string;
  mode: 'private' | 'cloud';
  request: DeliverableRequest;
  conversationId?: string;
  taskId?: string;
  retentionDays?: number;
};

export type GenerationResult = TreeWriteResult & {
  kind: GeneratedTree['kind'];
  title: string;
  checks: VerificationCheck[];
};

function modelOf(request: DocumentRequest): {
  version: 1;
  title: string;
  subtitle?: string;
  author?: string;
  blocks: DocumentRequest['blocks'];
} {
  return {
    version: 1,
    title: request.title,
    ...(request.subtitle ? { subtitle: request.subtitle } : {}),
    ...(request.author ? { author: request.author } : {}),
    blocks: request.blocks,
  };
}

async function generateDocument(request: DocumentRequest): Promise<GeneratedTree> {
  if (request.base) {
    throw new RangeError(
      'Durable generation edits a stored model through a new version; a workspace base path is not accepted.',
    );
  }
  if (request.formats.includes('html')) {
    throw new RangeError('HTML is not an accepted durable artifact media type.');
  }

  const model = applyDocumentEdits(modelOf(request), request.edits);
  const modelJson = `${JSON.stringify(model, null, 2)}\n`;
  const prefix = `documents/${request.filename}`;
  const files: GeneratedArtifactFile[] = [
    {
      relativePath: `${prefix}.document.json`,
      mediaType: 'application/json',
      kind: 'other',
      content: Buffer.from(modelJson, 'utf8'),
    },
  ];
  const checks: VerificationCheck[] = [
    {
      name: 'document.model',
      ok: JSON.parse(modelJson).version === 1,
      detail: `${model.blocks.length} editable blocks in the persisted model.`,
    },
  ];


  if (request.formats.includes('docx')) {
    const docx = await renderDocx(model);
    files.push({
      relativePath: `${prefix}.docx`,
      mediaType: DOCX,
      kind: 'document',
      content: docx,
    });
    try {
      const analysis = analyzeDocx(docx);
      const headings = model.blocks.filter((block) => block.type === 'heading').length;
      const tables = model.blocks.filter((block) => block.type === 'table').length;
      checks.push({
        name: 'docx.structure',
        ok: analysis.paragraphs.length > 0,
        detail: `${analysis.paragraphs.length} paragraphs and ${analysis.tableCount} tables read back.`,
      });
      checks.push({
        name: 'docx.headings',
        ok: analysis.headings.length === headings,
        detail: `Expected ${headings} headings, read ${analysis.headings.length}.`,
      });
      checks.push({
        name: 'docx.tables',
        ok: analysis.tableCount === tables,
        detail: `Expected ${tables} tables, read ${analysis.tableCount}.`,
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
    files.push({
      relativePath: `${prefix}.pdf`,
      mediaType: 'application/pdf',
      kind: 'pdf',
      content: pdf,
    });
    const verified = verifyPdf(pdf);
    checks.push({ name: 'pdf.structure', ok: verified.ok, detail: verified.detail });
  }

  if (request.formats.includes('markdown')) {
    const markdown = renderMarkdown(model);
    files.push({
      relativePath: `${prefix}.md`,
      mediaType: 'text/markdown',
      kind: 'document',
      content: Buffer.from(markdown, 'utf8'),
    });
    checks.push({
      name: 'markdown.content',
      ok: markdown.includes(model.title) && markdown.length > model.title.length,
      detail: `${markdown.length} characters of Markdown include the title.`,
    });
  }

  return { kind: 'document', title: request.title, files, checks };
}

async function generateSpreadsheet(request: SpreadsheetRequest): Promise<GeneratedTree> {
  const build = await renderWorkbook(request);
  const prefix = `workbooks/${request.filename}`;
  const verification = await verifyWorkbook(build.buffer, request);
  const model = { ...request } as Record<string, unknown>;
  delete model.mode;
  return {
    kind: 'spreadsheet',
    title: request.title,
    files: [
      {
        relativePath: `${prefix}.xlsx`,
        mediaType: XLSX,
        kind: 'spreadsheet',
        content: build.buffer,
      },
      {
        relativePath: `${prefix}.workbook.json`,
        mediaType: 'application/json',
        kind: 'other',
        content: Buffer.from(`${JSON.stringify(model, null, 2)}\n`, 'utf8'),
      },
    ],
    checks: [
      { name: 'xlsx.reopen', ok: verification.ok, detail: verification.detail },
      {
        name: 'xlsx.structure',
        ok: build.sheets === request.sheets.length,
        detail: `${build.sheets} worksheets written for ${request.sheets.length} requested.`,
      },
      {
        name: 'xlsx.charts',
        ok:
          build.charts ===
          request.sheets.reduce((total, sheet) => total + sheet.charts.length, 0),
        detail: `${build.charts} native chart parts written.`,
      },
      {
        name: 'xlsx.formulas',
        ok:
          build.formulas >=
          request.sheets.reduce((total, sheet) => total + sheet.formulas.length, 0),
        detail: `${build.formulas} formulas and totals written.`,
      },
    ],
  };
}

async function generatePresentation(request: PresentationRequest): Promise<GeneratedTree> {
  const buffer = await renderPresentation(request);
  const prefix = `decks/${request.filename}`;
  const verification = verifyPresentation(buffer, request);
  const model = { ...request } as Record<string, unknown>;
  delete model.mode;
  return {
    kind: 'presentation',
    title: request.title,
    files: [
      {
        relativePath: `${prefix}.pptx`,
        mediaType: PPTX,
        kind: 'presentation',
        content: buffer,
      },
      {
        relativePath: `${prefix}.deck.json`,
        mediaType: 'application/json',
        kind: 'other',
        content: Buffer.from(`${JSON.stringify(model, null, 2)}\n`, 'utf8'),
      },
    ],
    checks: [
      { name: 'pptx.reopen', ok: verification.ok, detail: verification.detail },
    ],
  };
}

function mediaForPath(relativePath: string): 'application/json' | 'text/markdown' | 'text/plain' {
  if (relativePath.endsWith('.json')) return 'application/json';
  if (relativePath.endsWith('.md')) return 'text/markdown';
  return 'text/plain';
}

async function generateSoftware(request: SoftwareRequest): Promise<GeneratedTree> {
  const root = await mkdtemp(join(tmpdir(), 'coderax-generator-'));
  try {
    const build = await buildSoftware({
      request,
      root,
      folder: 'project',
      authorize: async () => true,
    });
    const files: GeneratedArtifactFile[] = [];
    for (const file of build.files) {
      const relativePath = file.path.startsWith('project/')
        ? file.path.slice('project/'.length)
        : file.path;
      files.push({
        relativePath,
        mediaType: mediaForPath(relativePath),
        kind: 'software',
        content: await readFile(join(root, file.path)),
      });
    }
    return {
      kind: 'software',
      title: request.name,
      files,
      checks: build.checks,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Produces the bytes and verification checks; it performs no durable write. */
export async function generateTree(
  request: DeliverableRequest,
): Promise<ServiceResult<GeneratedTree>> {
  try {
    switch (request.kind) {
      case 'document':
        return ok(await generateDocument(request));
      case 'spreadsheet':
        return ok(await generateSpreadsheet(request));
      case 'presentation':
        return ok(await generatePresentation(request));
      case 'software':
        return ok(await generateSoftware(request));
      default:
        return fail(
          'validation_failed',
          'Only document, spreadsheet, presentation and software deliverables are durable artifacts.',
        );
    }
  } catch (error) {
    return fail(
      error instanceof RangeError ? 'validation_failed' : 'internal_error',
      error instanceof Error ? error.message : 'The deliverable could not be generated.',
    );
  }
}

/**
 * Wires the artifact-intelligence renderers to the durable tree adapter.
 *
 * The generator owns bytes and verification; the adapter owns identities,
 * versions, project paths and quota. A verification failure stops before any
 * durable write, so a malformed document never becomes an artifact.
 */
export function createArtifactGenerator(deps: { artifacts: ArtifactService }) {
  const writer = createArtifactTreeWriter(deps);
  return {
    generate: async (
      principal: Principal,
      input: GenerationInput,
    ): Promise<ServiceResult<GenerationResult>> => {
      const parsed = DeliverableRequest.safeParse(input.request);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return fail(
          'validation_failed',
          issue ? `${issue.path.join('.') || 'request'}: ${issue.message}` : 'Invalid deliverable request.',
        );
      }
      const generated = await generateTree(parsed.data);
      if (!generated.ok) return generated;
      const failed = generated.value.checks.find((check) => !check.ok);
      if (failed) {
        return fail(
          'internal_error',
          `The ${generated.value.kind} did not pass verification: ${failed.name}: ${failed.detail}`,
        );
      }
      const written = await writer.persist(principal, {
        projectId: input.projectId,
        mode: input.mode,
        files: generated.value.files,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.retentionDays !== undefined
          ? { retentionDays: input.retentionDays }
          : {}),
      });
      if (!written.ok) return written;
      return ok({
        ...written.value,
        kind: generated.value.kind,
        title: generated.value.title,
        checks: generated.value.checks,
      });
    },
  };
}
