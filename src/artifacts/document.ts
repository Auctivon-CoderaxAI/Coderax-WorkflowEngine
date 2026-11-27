import {
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { DocumentBlock, DocumentEdit, StoredDocument } from '@coderax/contracts';
import { readZip, ZipError } from './zip.js';
import { renderPdf } from './pdf.js';

/**
 * Documents are generated from a persisted model, not from a one-shot string.
 *
 * The model is written beside each artifact as `<name>.document.json`, so a later
 * request can edit the document (append, replace, remove, retitle) and re-render
 * every format from one source of truth. DOCX/PDF/Markdown/HTML are renderings of
 * that model; the DOCX that was written is read back and analysed, which is the
 * verification, not a second independent document.
 */

export type DocumentModel = StoredDocument;

const DEFAULT_FONT = 'Calibri';

export function applyDocumentEdits(model: DocumentModel, edits: DocumentEdit[]): DocumentModel {
  let blocks: DocumentBlock[] = [...model.blocks];
  let title = model.title;
  for (const edit of edits) {
    switch (edit.op) {
      case 'append':
        blocks = [...blocks, ...edit.blocks];
        break;
      case 'replace':
        if (edit.index >= blocks.length) {
          throw new RangeError(`Block ${edit.index} does not exist in this document.`);
        }
        blocks = blocks.map((block, index) => (index === edit.index ? edit.block : block));
        break;
      case 'remove':
        if (edit.index >= blocks.length) {
          throw new RangeError(`Block ${edit.index} does not exist in this document.`);
        }
        blocks = blocks.filter((_, index) => index !== edit.index);
        break;
      case 'setTitle':
        title = edit.title;
        break;
    }
  }
  if (blocks.length === 0) {
    throw new RangeError('A document must keep at least one block.');
  }
  return { ...model, title, blocks };
}

function headingLevel(level: number) {
  return level <= 1
    ? HeadingLevel.HEADING_1
    : level === 2
      ? HeadingLevel.HEADING_2
      : HeadingLevel.HEADING_3;
}

function textRun(text: string, options: { bold?: boolean; italics?: boolean; font?: string; size?: number } = {}) {
  return new TextRun({
    text,
    ...(options.bold ? { bold: true } : {}),
    ...(options.italics ? { italics: true } : {}),
    ...(options.font ? { font: options.font } : {}),
    ...(options.size ? { size: options.size } : {}),
  });
}

function tableRow(cells: string[], header: boolean): TableRow {
  return new TableRow({
    tableHeader: header,
    children: cells.map(
      (cell) =>
        new TableCell({
          shading: header
            ? { type: ShadingType.CLEAR, fill: 'F1F3F5', color: 'auto' }
            : { type: ShadingType.CLEAR, fill: 'FFFFFF', color: 'auto' },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [
            new Paragraph({
              children: [textRun(cell, { bold: header, size: 20 })],
            }),
          ],
        }),
    ),
  });
}

function paragraphFor(block: DocumentBlock): Paragraph | Table | null {
  switch (block.type) {
    case 'heading':
      return new Paragraph({
        heading: headingLevel(block.level),
        spacing: { before: block.level === 1 ? 320 : 240, after: 120 },
        children: [textRun(block.text)],
      });
    case 'paragraph':
      return new Paragraph({
        spacing: { after: 120 },
        children: [textRun(block.text)],
      });
    case 'bullets':
      return null;
    case 'numbers':
      return null;
    case 'quote':
      return new Paragraph({
        spacing: { before: 80, after: 160 },
        indent: { left: 360 },
        border: {
          left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D4DA', space: 10 },
        },
        children: [textRun(block.text, { italics: true })],
      });
    case 'table':
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          tableRow(block.headers, true),
          ...block.rows.map((row) => tableRow(row, false)),
        ],
      });
    case 'pageBreak':
      return new Paragraph({ children: [new PageBreak()] });
    case 'code':
      return new Paragraph({
        spacing: { before: 120, after: 160 },
        shading: { type: ShadingType.CLEAR, fill: 'F6F7F9', color: 'auto' },
        indent: { left: 240, right: 240 },
        children: block.text.split('\n').flatMap((line, index) => [
          ...(index === 0 ? [] : [new TextRun({ break: 1 })]),
          textRun(line.length > 0 ? line : ' ', { font: 'Consolas', size: 18 }),
        ]),
      });
  }
}

/**
 * A list renders as one paragraph per item so Word keeps each item's formatting
 * and indentation independent; the marker is part of the text, which is what
 * `docx`'s numbering configuration would otherwise require a numbering part for.
 */
function listParagraphs(block: Extract<DocumentBlock, { type: 'bullets' | 'numbers' }>): Paragraph[] {
  return block.items.map((item, index) =>
    new Paragraph({
      spacing: { after: 60 },
      indent: { left: 360, hanging: 220 },
      children: [
        textRun(block.type === 'bullets' ? '\u2022' : `${index + 1}.`, { bold: false }),
        textRun(` ${item}`),
      ],
    }),
  );
}

export async function renderDocx(model: DocumentModel): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  children.push(
    new Paragraph({
      spacing: { after: 80 },
      children: [textRun(model.title, { bold: true, size: 48 })],
    }),
  );
  if (model.subtitle) {
    children.push(
      new Paragraph({
        spacing: { after: 80 },
        children: [textRun(model.subtitle, { size: 26, font: DEFAULT_FONT })],
      }),
    );
  }
  if (model.author) {
    children.push(
      new Paragraph({
        spacing: { after: 240 },
        children: [textRun(model.author, { size: 20 })],
      }),
    );
  }

  for (const block of model.blocks) {
    if (block.type === 'bullets' || block.type === 'numbers') {
      children.push(...listParagraphs(block));
      continue;
    }
    const paragraph = paragraphFor(block);
    if (paragraph) children.push(paragraph);
  }

  const doc = new Document({
    creator: model.author ?? 'Coderax Native',
    title: model.title,
    description: model.subtitle ?? 'Generated by Coderax WorkflowEngine',
    styles: {
      default: {
        document: {
          run: { font: DEFAULT_FONT, size: 22 },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export function renderMarkdown(model: DocumentModel): string {
  const lines: string[] = [`# ${model.title}`, ''];
  if (model.subtitle) lines.push(`_${model.subtitle}_`, '');
  if (model.author) lines.push(`**${model.author}**`, '');
  for (const block of model.blocks) {
    switch (block.type) {
      case 'heading':
        lines.push(`${'#'.repeat(block.level + 1)} ${block.text}`, '');
        break;
      case 'paragraph':
        lines.push(block.text, '');
        break;
      case 'bullets':
        for (const item of block.items) lines.push(`- ${item}`);
        lines.push('');
        break;
      case 'numbers':
        block.items.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
        lines.push('');
        break;
      case 'quote':
        lines.push(`> ${block.text}`, '');
        break;
      case 'code':
        lines.push(`\`\`\`${block.language ?? ''}`.trimEnd(), block.text, '```', '');
        break;
      case 'table':
        lines.push(`| ${block.headers.join(' | ')} |`);
        lines.push(`| ${block.headers.map(() => '---').join(' | ')} |`);
        for (const row of block.rows) lines.push(`| ${row.join(' | ')} |`);
        lines.push('');
        break;
      case 'pageBreak':
        lines.push('---', '');
        break;
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderHtml(model: DocumentModel): string {
  const body: string[] = [`<h1>${escapeHtml(model.title)}</h1>`];
  if (model.subtitle) body.push(`<p class="subtitle">${escapeHtml(model.subtitle)}</p>`);
  if (model.author) body.push(`<p class="author">${escapeHtml(model.author)}</p>`);
  for (const block of model.blocks) {
    switch (block.type) {
      case 'heading': {
        const tag = `h${block.level + 1}`;
        body.push(`<${tag}>${escapeHtml(block.text)}</${tag}>`);
        break;
      }
      case 'paragraph':
        body.push(`<p>${escapeHtml(block.text)}</p>`);
        break;
      case 'bullets':
        body.push(`<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`);
        break;
      case 'numbers':
        body.push(`<ol>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`);
        break;
      case 'quote':
        body.push(`<blockquote>${escapeHtml(block.text)}</blockquote>`);
        break;
      case 'code':
        body.push(
          `<pre><code class="language-${escapeHtml(block.language ?? 'text')}">${escapeHtml(block.text)}</code></pre>`,
        );
        break;
      case 'table':
        body.push(
          `<table><thead><tr>${block.headers
            .map((header) => `<th>${escapeHtml(header)}</th>`)
            .join('')}</tr></thead><tbody>${block.rows
            .map(
              (row) =>
                `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
            )
            .join('')}</tbody></table>`,
        );
        break;
      case 'pageBreak':
        body.push('<hr>');
        break;
    }
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="generator" content="Coderax WorkflowEngine">
<title>${escapeHtml(model.title)}</title>
<style>
  body { font: 16px/1.6 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1.5rem; color: #1b1f24; }
  h1 { font-size: 2.2rem; margin-bottom: .2rem; }
  h2 { margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; margin: 1.2rem 0; }
  th, td { border: 1px solid #d7dbe0; padding: .45rem .6rem; text-align: left; }
  th { background: #f1f3f5; }
  pre { background: #f6f7f9; padding: 1rem; overflow-x: auto; }
  blockquote { border-left: 3px solid #d7dbe0; margin-left: 0; padding-left: 1rem; color: #4b5563; }
  .subtitle { font-size: 1.15rem; color: #4b5563; margin-top: 0; }
  .author { color: #6b7280; }
</style>
</head>
<body>
${body.join('\n')}
</body>
</html>
`;
}

export async function renderDocumentPdf(model: DocumentModel): Promise<Buffer> {
  return renderPdf({
    title: model.title,
    ...(model.subtitle ? { subtitle: model.subtitle } : {}),
    ...(model.author ? { author: model.author } : {}),
    blocks: model.blocks,
  });
}

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export type DocxParagraph = {
  text: string;
  heading?: 1 | 2 | 3;
  list: boolean;
};

export type DocxAnalysis = {
  paragraphs: DocxParagraph[];
  tableCount: number;
  wordCount: number;
  characterCount: number;
  headings: string[];
};

/**
 * Reads a DOCX back. This is deliberately an analysis of the produced document,
 * not a round-trip through another renderer: it proves the file contains the
 * headings, paragraphs, lists and tables that were requested.
 */
export function analyzeDocx(buffer: Buffer): DocxAnalysis {
  const parts = readZip(buffer);
  const xml = parts.get('word/document.xml');
  if (!xml) throw new ZipError('The document part is missing from the DOCX.');
  const documentXml = xml.toString('utf8');
  const paragraphs: DocxParagraph[] = [];
  const matches = documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g);
  for (const match of matches) {
    const inner = match[1] ?? '';
    const texts = [...inner.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((part) =>
      decodeXml(part[1] ?? ''),
    );
    const text = texts.join('').trim();
    if (text.length === 0) continue;
    const styleMatch = /<w:pStyle w:val="Heading([123])"/.exec(inner);
    const heading = styleMatch ? (Number.parseInt(styleMatch[1] ?? '1', 10) as 1 | 2 | 3) : undefined;
    paragraphs.push({
      text,
      ...(heading ? { heading } : {}),
      list: /<w:numPr>/.test(inner),
    });
  }
  const wordCount = paragraphs.reduce(
    (total, paragraph) => total + paragraph.text.split(/\s+/).filter(Boolean).length,
    0,
  );
  return {
    paragraphs,
    tableCount: (documentXml.match(/<w:tbl>/g) ?? []).length,
    wordCount,
    characterCount: paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0),
    headings: paragraphs.filter((paragraph) => paragraph.heading).map((paragraph) => paragraph.text),
  };
}

const STOP_WORDS = new Set(
  'a an and are as at be by for from has have in is it its of on or that the this to was were will with'.split(
    ' ',
  ),
);

/**
 * Extractive summarization: a sentence is scored by the frequency of its
 * non-stopword terms and selected in original order. No model is involved, so a
 * summary always describes text that is actually present in the document.
 */
export function summarizeExtractively(text: string, maxSentences = 4): string {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
  if (sentences.length === 0) return '';
  const frequency = new Map<string, number>();
  for (const sentence of sentences) {
    for (const word of sentence.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []) {
      if (STOP_WORDS.has(word)) continue;
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }
  const scored = sentences.map((sentence, index) => {
    const terms = (sentence.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter(
      (word) => !STOP_WORDS.has(word),
    );
    const score =
      terms.reduce((total, term) => total + (frequency.get(term) ?? 0), 0) / Math.max(6, terms.length + 6);
    return { sentence, index, score };
  });
  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(maxSentences, sentences.length))
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.sentence)
    .join(' ');
}

export function documentText(model: DocumentModel): string {
  return model.blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
        case 'paragraph':
        case 'quote':
          return block.text;
        case 'bullets':
        case 'numbers':
          return block.items.join('\n');
        case 'code':
          return block.text;
        case 'table':
          return [block.headers.join(' '), ...block.rows.map((row) => row.join(' '))].join('\n');
        case 'pageBreak':
          return '';
      }
    })
    .filter((value) => value.length > 0)
    .join('\n\n');
}
