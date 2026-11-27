import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ChartSpec, DocumentBlock } from '@coderax/contracts';

/**
 * A real PDF writer: A4 pages, wrapped body text, headings, lists, quotes, code,
 * tables and vector charts, with a footer on every page. Text is encoded as
 * WinAnsi because only the PDF standard fonts are embedded; the sanitizer makes
 * that explicit instead of letting a character throw mid-render.
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM = 64;

const COLOURS = {
  ink: rgb(0.11, 0.13, 0.17),
  muted: rgb(0.42, 0.45, 0.5),
  rule: rgb(0.84, 0.86, 0.89),
  panel: rgb(0.96, 0.97, 0.98),
  accent: rgb(0.16, 0.36, 0.72),
};

const CHART_COLOURS = [
  rgb(0.16, 0.36, 0.72),
  rgb(0.85, 0.45, 0.16),
  rgb(0.2, 0.55, 0.4),
  rgb(0.55, 0.3, 0.65),
  rgb(0.75, 0.25, 0.3),
  rgb(0.35, 0.55, 0.7),
];

const WIN_ANSI_SPECIALS = new Set(
  [...'\u20ac\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u017d\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u017e\u0178'].map(
    (character) => character.codePointAt(0) ?? -1,
  ),
);

/**
 * The PDF standard fonts cannot encode arbitrary Unicode. Unsupported
 * characters become `?` rather than corrupting the document or failing a run.
 */
export function toWinAnsi(value: string): string {
  let out = '';
  for (const character of value.replace(/\r\n?/g, '\n')) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\n') {
      out += '\n';
    } else if (character === '\t') {
      out += '    ';
    } else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_SPECIALS.has(code)) {
      out += character;
    } else if (character === '\u2011' || character === '\u2010') {
      out += '-';
    } else {
      out += '?';
    }
  }
  return out;
}

type Fonts = {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  mono: PDFFont;
};

export type PdfBlock =
  | DocumentBlock
  | { type: 'chart'; chart: ChartSpec; caption?: string };

export type PdfDocumentInput = {
  title: string;
  subtitle?: string;
  author?: string;
  blocks: PdfBlock[];
  footerNote?: string;
};

/**
 * Splits a token that is wider than the line into the largest chunks that fit.
 *
 * Grow from a wide-glyph estimate until the prefix overflows, then binary-search
 * that interval. Measurements stay local even for very long tokens.
 */
function breakToken(font: PDFFont, size: number, width: number, token: string): string[] {
  const limit = Math.max(1, width);
  const widest = Math.max(1, font.widthOfTextAtSize('W', size));
  const cap = Math.max(1, Math.min(token.length, Math.floor(limit / widest) + 1));
  const parts: string[] = [];
  let rest = token;
  while (rest.length > 0) {
    let low = 1;
    let high = Math.min(rest.length, cap);
    let best = 1;
    while (font.widthOfTextAtSize(rest.slice(0, high), size) <= limit) {
      best = high;
      low = high + 1;
      if (high === rest.length) break;
      high = Math.min(rest.length, high * 2);
    }
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (font.widthOfTextAtSize(rest.slice(0, mid), size) <= limit) {
        best = Math.max(best, mid);
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    parts.push(rest.slice(0, best));
    rest = rest.slice(best);
  }
  return parts.length > 0 ? parts : [token];
}

function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  const paragraphs = text.split('\n');
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line.length > 0) lines.push(line);
      if (font.widthOfTextAtSize(word, size) <= width) {
        line = word;
        continue;
      }
      const parts = breakToken(font, size, width, word);
      for (const part of parts.slice(0, -1)) lines.push(part);
      line = parts[parts.length - 1] ?? '';
    }
    lines.push(line);
  }
  return lines;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, Math.max(0, length - 1))}\u2026`;
}

class PdfWriter {
  private readonly doc: PDFDocument;
  private readonly fonts: Fonts;
  private pages: PDFPage[] = [];
  private page: PDFPage;
  private y: number;
  private readonly title: string;
  private readonly footerNote: string | undefined;

  constructor(input: {
    doc: PDFDocument;
    fonts: Fonts;
    title: string;
    footerNote?: string;
    firstPage?: PDFPage;
  }) {
    this.doc = input.doc;
    this.fonts = input.fonts;
    this.title = input.title;
    this.footerNote = input.footerNote;
    this.page = input.firstPage ?? this.newPage();
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private newPage(): PDFPage {
    return this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  }

  addPage(): void {
    this.page = this.newPage();
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private ensure(height: number): void {
    if (this.y - height < BOTTOM) this.addPage();
  }

  space(height: number): void {
    this.y -= height;
  }

  text(
    value: string,
    options: {
      font?: keyof Fonts;
      size?: number;
      colour?: ReturnType<typeof rgb>;
      indent?: number;
      width?: number;
      lineHeight?: number;
      gap?: number;
    } = {},
  ): void {
    const font = this.fonts[options.font ?? 'regular'];
    const size = options.size ?? 10.5;
    const indent = options.indent ?? 0;
    const width = options.width ?? CONTENT_WIDTH - indent;
    const lineHeight = options.lineHeight ?? size * 1.45;
    const lines = wrapText(toWinAnsi(value), font, size, width);
    for (const line of lines) {
      this.ensure(lineHeight);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y - size,
        size,
        font,
        color: options.colour ?? COLOURS.ink,
      });
      this.y -= lineHeight;
    }
    this.y -= options.gap ?? 0;
  }

  rule(): void {
    this.ensure(10);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.6,
      color: COLOURS.rule,
    });
    this.y -= 10;
  }

  heading(level: number, value: string): void {
    const bounded = level <= 1 ? 1 : level === 2 ? 2 : 3;
    const size = bounded === 1 ? 19 : bounded === 2 ? 14 : 11.5;
    this.space(bounded === 1 ? 6 : 8);
    this.ensure(size * 2.2);
    this.text(value, { font: 'bold', size, lineHeight: size * 1.3, colour: COLOURS.ink });
    this.space(bounded === 1 ? 6 : 4);
  }

  bullets(items: string[], ordered: boolean): void {
    items.forEach((item, index) => {
      const prefix = ordered ? `${index + 1}.` : '\u2022';
      this.text(prefix, {
        indent: 4,
        width: 18,
        size: 10.5,
        lineHeight: 14,
        colour: orderColour(ordered),
        gap: 0,
      });
      const markerLines = 1;
      this.y += 14 * markerLines;
      this.text(item, { indent: 22, width: CONTENT_WIDTH - 22, lineHeight: 14, gap: 3 });
    });
    this.space(4);
  }

  quote(value: string): void {
    const startY = this.y;
    this.text(value, { font: 'italic', indent: 14, width: CONTENT_WIDTH - 20, lineHeight: 14.5 });
    this.page.drawLine({
      start: { x: MARGIN + 4, y: startY },
      end: { x: MARGIN + 4, y: this.y + 2 },
      thickness: 2,
      color: COLOURS.rule,
    });
    this.space(6);
  }

  code(value: string, language: string | undefined): void {
    const font = this.fonts.mono;
    const size = 8.5;
    const lineHeight = 11.5;
    const lines: string[] = [];
    for (const raw of toWinAnsi(value).split('\n')) {
      const rest = raw.length === 0 ? ' ' : raw;
      lines.push(...breakToken(font, size, CONTENT_WIDTH - 20, rest));
    }
    const height = lines.length * lineHeight + 12;
    this.ensure(height + 8);
    const top = this.y;
    this.page.drawRectangle({
      x: MARGIN,
      y: top - height,
      width: CONTENT_WIDTH,
      height,
      color: COLOURS.panel,
    });
    if (language) {
      this.page.drawText(toWinAnsi(language), {
        x: MARGIN + 8,
        y: top - 10,
        size: 7,
        font: this.fonts.regular,
        color: COLOURS.muted,
      });
    }
    let cursor = top - 12;
    for (const line of lines) {
      this.page.drawText(line, {
        x: MARGIN + 8,
        y: cursor - size,
        size,
        font,
        color: COLOURS.ink,
      });
      cursor -= lineHeight;
    }
    this.y = top - height - 8;
  }

  table(headers: string[], rows: string[][]): void {
    const columns = headers.length;
    const colWidth = CONTENT_WIDTH / columns;
    const padding = 5;
    const size = 8.5;
    const lineHeight = 11;
    const drawHeader = (): void => {
      const headerLines = headers.map((header) =>
        wrapText(toWinAnsi(header), this.fonts.bold, size, colWidth - padding * 2),
      );
      const height = Math.max(...headerLines.map((lines) => lines.length)) * lineHeight + padding * 2;
      this.ensure(height);
      const top = this.y;
      this.page.drawRectangle({
        x: MARGIN,
        y: top - height,
        width: CONTENT_WIDTH,
        height,
        color: COLOURS.panel,
      });
      headerLines.forEach((lines, column) => {
        lines.forEach((line, index) => {
          this.page.drawText(line, {
            x: MARGIN + column * colWidth + padding,
            y: top - padding - size - index * lineHeight,
            size,
            font: this.fonts.bold,
            color: COLOURS.ink,
          });
        });
      });
      this.y = top - height;
    };

    drawHeader();
    for (const row of rows) {
      const cells = headers.map((_, column) =>
        wrapText(toWinAnsi(String(row[column] ?? '')), this.fonts.regular, size, colWidth - padding * 2),
      );
      const height = Math.max(1, ...cells.map((lines) => lines.length)) * lineHeight + padding * 2;
      if (this.y - height < BOTTOM) {
        this.addPage();
        drawHeader();
      }
      const top = this.y;
      cells.forEach((lines, column) => {
        lines.forEach((line, index) => {
          this.page.drawText(line, {
            x: MARGIN + column * colWidth + padding,
            y: top - padding - size - index * lineHeight,
            size,
            font: this.fonts.regular,
            color: COLOURS.ink,
          });
        });
      });
      this.y = top - height;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: PAGE_WIDTH - MARGIN, y: this.y },
        thickness: 0.4,
        color: COLOURS.rule,
      });
    }
    this.space(10);
  }

  chart(spec: ChartSpec, caption?: string): void {
    const height = 210;
    this.ensure(height + 40);
    const top = this.y;
    this.page.drawText(truncate(toWinAnsi(spec.title), 90), {
      x: MARGIN,
      y: top - 12,
      size: 10,
      font: this.fonts.bold,
      color: COLOURS.ink,
    });

    const chartTop = top - 26;
    const chartHeight = height - 46;
    const chartWidth = CONTENT_WIDTH - 110;
    const originX = MARGIN + 46;
    const originY = chartTop - chartHeight;

    if (spec.type === 'pie') {
      const total = spec.series[0]?.values.reduce((sum, value) => sum + Math.max(0, value), 0) ?? 0;
      const radius = Math.min(chartWidth, chartHeight) / 2 - 6;
      const centerX = originX + chartWidth / 2;
      const centerY = originY + chartHeight / 2;
      let angle = -Math.PI / 2;
      const values = spec.series[0]?.values ?? [];
      // drawSvgPath uses a y-down coordinate system anchored at the page top.
      const sy = (value: number): number => PAGE_HEIGHT - value;
      values.forEach((value, index) => {
        const slice = total > 0 ? (Math.max(0, value) / total) * Math.PI * 2 : 0;
        if (slice <= 0) return;
        const next = angle + slice;
        const x1 = centerX + radius * Math.cos(angle);
        const y1 = centerY + radius * Math.sin(angle);
        const x2 = centerX + radius * Math.cos(next);
        const y2 = centerY + radius * Math.sin(next);
        const large = slice > Math.PI ? 1 : 0;
        const path = `M ${centerX} ${sy(centerY)} L ${x1} ${sy(y1)} A ${radius} ${radius} 0 ${large} 1 ${x2} ${sy(y2)} Z`;
        this.page.drawSvgPath(path, {
          x: 0,
          y: PAGE_HEIGHT,
          color: CHART_COLOURS[index % CHART_COLOURS.length],
          borderWidth: 0,
        });
        angle = next;
      });
      this.legend(spec, MARGIN + 46, originY - 4, chartWidth);
      this.y = top - height;
      if (caption) this.text(caption, { size: 8, colour: COLOURS.muted });
      this.space(6);
      return;
    }

    const allValues = spec.series.flatMap((series) => series.values);
    const max = Math.max(1, ...allValues);
    const min = Math.min(0, ...allValues);
    const span = max - min || 1;
    const scaleY = (value: number): number => originY + ((value - min) / span) * chartHeight;
    this.page.drawLine({
      start: { x: originX, y: originY },
      end: { x: originX, y: chartTop },
      thickness: 0.7,
      color: COLOURS.rule,
    });
    this.page.drawLine({
      start: { x: originX, y: originY },
      end: { x: originX + chartWidth, y: originY },
      thickness: 0.7,
      color: COLOURS.rule,
    });
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = min + (span * tick) / 4;
      const y = scaleY(value);
      this.page.drawText(formatAxis(value), {
        x: MARGIN,
        y: y - 3,
        size: 7,
        font: this.fonts.regular,
        color: COLOURS.muted,
      });
      if (tick > 0) {
        this.page.drawLine({
          start: { x: originX, y },
          end: { x: originX + chartWidth, y },
          thickness: 0.3,
          color: COLOURS.rule,
        });
      }
    }

    const categories = spec.categories.length;
    const groupWidth = chartWidth / Math.max(1, categories);

    if (spec.type === 'bar') {
      const barWidth = Math.max(2, (groupWidth * 0.7) / spec.series.length);
      spec.series.forEach((series, seriesIndex) => {
        series.values.forEach((value, index) => {
          const x = originX + index * groupWidth + groupWidth * 0.15 + seriesIndex * barWidth;
          const y = scaleY(Math.max(min, value));
          const base = scaleY(Math.max(min, 0));
          this.page.drawRectangle({
            x,
            y: Math.min(y, base),
            width: Math.max(1, barWidth - 1.5),
            height: Math.max(0.8, Math.abs(base - y)),
            color: CHART_COLOURS[seriesIndex % CHART_COLOURS.length],
          });
        });
      });
    } else {
      spec.series.forEach((series, seriesIndex) => {
        const colour = CHART_COLOURS[seriesIndex % CHART_COLOURS.length];
        const points = series.values.map((value, index) => ({
          x: originX + index * groupWidth + groupWidth / 2,
          y: scaleY(Math.max(min, value)),
        }));
        for (let index = 1; index < points.length; index += 1) {
          this.page.drawLine({
            start: points[index - 1]!,
            end: points[index]!,
            thickness: 1.6,
            color: colour,
          });
        }
        for (const point of points) {
          this.page.drawCircle({ x: point.x, y: point.y, size: 1.8, color: colour });
        }
      });
    }

    spec.categories.forEach((category, index) => {
      const label = truncate(toWinAnsi(category), 12);
      const x = originX + index * groupWidth + groupWidth / 2;
      this.page.drawText(label, {
        x: x - this.fonts.regular.widthOfTextAtSize(label, 6.5) / 2,
        y: originY - 10,
        size: 6.5,
        font: this.fonts.regular,
        color: COLOURS.muted,
      });
    });

    this.legend(spec, originX, originY - 24, chartWidth);
    this.y = top - height;
    if (caption) this.text(caption, { size: 8, colour: COLOURS.muted });
    this.space(6);
  }

  private legend(spec: ChartSpec, x: number, y: number, width: number): void {
    let cursor = x;
    const names =
      spec.type === 'pie' ? spec.categories : spec.series.map((series) => series.name);
    names.slice(0, 6).forEach((name, index) => {
      const label = truncate(toWinAnsi(name), 16);
      const labelWidth = this.fonts.regular.widthOfTextAtSize(label, 7) + 18;
      if (cursor + labelWidth > x + width) return;
      this.page.drawRectangle({
        x: cursor,
        y: y - 2,
        width: 7,
        height: 7,
        color: CHART_COLOURS[index % CHART_COLOURS.length],
      });
      this.page.drawText(label, {
        x: cursor + 10,
        y: y - 1,
        size: 7,
        font: this.fonts.regular,
        color: COLOURS.ink,
      });
      cursor += labelWidth;
    });
  }

  finish(): void {
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      page.drawLine({
        start: { x: MARGIN, y: 44 },
        end: { x: PAGE_WIDTH - MARGIN, y: 44 },
        thickness: 0.5,
        color: COLOURS.rule,
      });
      const left = truncate(toWinAnsi(this.footerNote ?? this.title), 70);
      page.drawText(left, {
        x: MARGIN,
        y: 32,
        size: 7.5,
        font: this.fonts.regular,
        color: COLOURS.muted,
      });
      const label = `Page ${index + 1} of ${total}`;
      page.drawText(label, {
        x: PAGE_WIDTH - MARGIN - this.fonts.regular.widthOfTextAtSize(label, 7.5),
        y: 32,
        size: 7.5,
        font: this.fonts.regular,
        color: COLOURS.muted,
      });
    });
    if (this.doc.getPageCount() > 0) {
      this.doc.setTitle(toWinAnsi(this.title));
    }
  }
}

function orderColour(ordered: boolean): ReturnType<typeof rgb> {
  return ordered ? COLOURS.accent : COLOURS.muted;
}

function formatAxis(value: number): string {
  if (Math.abs(value) >= 1000) return `${Math.round(value / 100) / 10}k`;
  return `${Math.round(value * 10) / 10}`;
}

export async function renderPdf(input: PdfDocumentInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(toWinAnsi(input.title));
  doc.setProducer('Coderax WorkflowEngine');
  doc.setCreator('Coderax Native');
  if (input.author) doc.setAuthor(toWinAnsi(input.author));

  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };

  const writer = new PdfWriter({
    doc,
    fonts,
    title: input.title,
    ...(input.footerNote ? { footerNote: input.footerNote } : {}),
  });

  writer.text(input.title, { font: 'bold', size: 24, lineHeight: 30 });
  if (input.subtitle) {
    writer.space(2);
    writer.text(input.subtitle, { size: 12, colour: COLOURS.muted, lineHeight: 17 });
  }
  if (input.author) {
    writer.space(2);
    writer.text(input.author, { size: 9.5, colour: COLOURS.muted });
  }
  writer.space(6);
  writer.rule();

  for (const block of input.blocks) {
    switch (block.type) {
      case 'heading':
        writer.heading(block.level, block.text);
        break;
      case 'paragraph':
        writer.text(block.text, { gap: 6 });
        break;
      case 'bullets':
        writer.bullets(block.items, false);
        break;
      case 'numbers':
        writer.bullets(block.items, true);
        break;
      case 'quote':
        writer.quote(block.text);
        break;
      case 'code':
        writer.code(block.text, block.language);
        break;
      case 'table':
        writer.table(block.headers, block.rows);
        break;
      case 'pageBreak':
        writer.addPage();
        break;
      case 'chart':
        writer.chart(block.chart, block.caption);
        break;
    }
  }

  writer.finish();
  return Buffer.from(await doc.save());
}

/** Structural verification: a readable PDF with the expected trailer. */
export function verifyPdf(buffer: Buffer): { ok: boolean; detail: string } {
  if (buffer.length < 100) return { ok: false, detail: 'The PDF is too small to be valid.' };
  const header = buffer.subarray(0, 5).toString('latin1');
  if (header !== '%PDF-') return { ok: false, detail: 'The PDF header is missing.' };
  const tail = buffer.subarray(Math.max(0, buffer.length - 1024)).toString('latin1');
  if (!tail.includes('%%EOF')) return { ok: false, detail: 'The PDF trailer is missing.' };
  if (!tail.includes('startxref')) return { ok: false, detail: 'The PDF cross-reference offset is missing.' };
  return { ok: true, detail: `${buffer.length} bytes, header and trailer verified.` };
}
