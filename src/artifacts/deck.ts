import PptxGenJS from 'pptxgenjs';
import type { ChartSpec, PresentationRequest, SlideRequest } from '@coderax/contracts';
import { readZip } from './zip.js';

/**
 * PPTX generation with editable slides.
 *
 * Every element is a native PowerPoint object: text boxes with real paragraphs,
 * tables, charts backed by their own chart parts, autoshape diagrams and speaker
 * notes. Nothing is a screenshot of a rendered page, so the deck remains editable
 * in PowerPoint, Keynote and LibreOffice.
 */

const INK = '1B1F24';
const MUTED = '4B5563';
const ACCENT = '245BA8';
const LIGHT = 'F1F3F5';
const WHITE = 'FFFFFF';

const SLIDE = { width: 13.333, height: 7.5 };

type PptxCtor = typeof import('pptxgenjs').default;
const PptxConstructor = PptxGenJS as unknown as PptxCtor;
type Pptx = InstanceType<PptxCtor>;
type Slide = ReturnType<Pptx['addSlide']>;

const CHART_COLOURS = ['245BA8', 'D97329', '338C66', '8C4DA6', 'BF4050', '598CB3'];

function addTitle(slide: Slide, title: string, dark = false): void {
  slide.addText(title, {
    x: 0.65,
    y: 0.42,
    w: SLIDE.width - 1.3,
    h: 0.9,
    fontSize: 30,
    bold: true,
    color: dark ? WHITE : INK,
    fontFace: 'Calibri',
  });
  slide.addShape('rect', {
    x: 0.65,
    y: 1.32,
    w: 1.1,
    h: 0.06,
    fill: { color: dark ? WHITE : ACCENT },
    line: { color: dark ? WHITE : ACCENT, width: 0 },
  });
}

function addBullets(slide: Slide, bullets: string[], box: { x: number; y: number; w: number; h: number }): void {
  if (bullets.length === 0) return;
  slide.addText(
    bullets.map((text) => ({
      text,
      options: { bullet: { characterCode: '2022' }, breakLine: true },
    })),
    {
      ...box,
      fontSize: 16,
      color: INK,
      fontFace: 'Calibri',
      lineSpacingMultiple: 1.15,
      valign: 'top',
    },
  );
}

function chartType(pptx: Pptx, type: ChartSpec['type']) {
  return type === 'line' ? pptx.ChartType.line : type === 'pie' ? pptx.ChartType.pie : pptx.ChartType.bar;
}

function addChart(slide: Slide, pptx: Pptx, chart: ChartSpec, box: { x: number; y: number; w: number; h: number }): void {
  slide.addChart(
    chartType(pptx, chart.type),
    chart.series.map((series) => ({ name: series.name, labels: chart.categories, values: series.values })),
    {
      ...box,
      showTitle: true,
      title: chart.title,
      titleFontSize: 13,
      showLegend: chart.type !== 'pie',
      showValue: false,
      chartColors: CHART_COLOURS,
      catAxisLabelFontSize: 10,
      valAxisLabelFontSize: 10,
    },
  );
}

function addTable(slide: Slide, table: { headers: string[]; rows: string[][] }, box: { x: number; y: number; w: number; h: number }): void {
  const rows = [
    table.headers.map((header) => ({
      text: header,
      options: { bold: true, color: WHITE, fill: { color: ACCENT }, fontSize: 12 },
    })),
    ...table.rows.map((row) =>
      row.map((cell, index) => ({
        text: cell,
        options: { fontSize: 11, fill: { color: index % 2 === 0 ? WHITE : LIGHT } },
      })),
    ),
  ];
  slide.addTable(rows, {
    ...box,
    border: { type: 'solid', color: 'D7DBE0', pt: 0.5 },
    fontFace: 'Calibri',
    color: INK,
    valign: 'middle',
    autoPage: false,
  });
}

function addFlow(slide: Slide, steps: string[], box: { x: number; y: number; w: number; h: number }): void {
  if (steps.length === 0) return;
  const gap = 0.16;
  const height = Math.min(0.52, (box.h - gap * (steps.length - 1)) / Math.max(1, steps.length));
  steps.forEach((label, index) => {
    const y = box.y + index * (height + gap);
    slide.addShape('roundRect', {
      x: box.x,
      y,
      w: box.w,
      h: height,
      fill: { color: index === 0 ? ACCENT : LIGHT },
      line: { color: index === 0 ? ACCENT : 'D7DBE0', width: 0.75 },
      rectRadius: 0.06,
    });
    slide.addText(label, {
      x: box.x + 0.15,
      y,
      w: box.w - 0.3,
      h: height,
      fontSize: 12,
      color: index === 0 ? WHITE : INK,
      bold: index === 0,
      valign: 'middle',
      fontFace: 'Calibri',
    });
    if (index < steps.length - 1) {
      slide.addShape('line', {
        x: box.x + box.w / 2,
        y: y + height,
        w: 0,
        h: gap,
        line: { color: '9AA3AE', width: 1, endArrowType: 'triangle' },
      });
    }
  });
}

function addSlide(pptx: Pptx, spec: SlideRequest): void {
  const slide = pptx.addSlide();

  if (spec.layout === 'title') {
    slide.background = { color: ACCENT };
    slide.addText(spec.title ?? '', {
      x: 0.9,
      y: 2.3,
      w: SLIDE.width - 1.8,
      h: 1.4,
      fontSize: 40,
      bold: true,
      color: WHITE,
      fontFace: 'Calibri',
    });
    if (spec.subtitle) {
      slide.addText(spec.subtitle, {
        x: 0.9,
        y: 3.9,
        w: SLIDE.width - 1.8,
        h: 0.9,
        fontSize: 20,
        color: 'DCE7F7',
        fontFace: 'Calibri',
      });
    }
  } else if (spec.layout === 'section') {
    slide.background = { color: 'EEF3FA' };
    slide.addShape('rect', { x: 0, y: 0, w: 0.28, h: SLIDE.height, fill: { color: ACCENT }, line: { color: ACCENT, width: 0 } });
    slide.addText(spec.title ?? '', {
      x: 0.9,
      y: 2.8,
      w: SLIDE.width - 1.8,
      h: 1.3,
      fontSize: 36,
      bold: true,
      color: INK,
      fontFace: 'Calibri',
    });
    if (spec.subtitle) {
      slide.addText(spec.subtitle, {
        x: 0.9,
        y: 4.15,
        w: SLIDE.width - 1.8,
        h: 0.8,
        fontSize: 18,
        color: MUTED,
        fontFace: 'Calibri',
      });
    }
  } else if (spec.layout === 'twoColumn' && spec.columns.length > 0) {
    addTitle(slide, spec.title ?? '');
    spec.columns.slice(0, 2).forEach((column, index) => {
      addBullets(slide, column, {
        x: 0.65 + index * 6.15,
        y: 1.65,
        w: 5.7,
        h: 5.1,
      });
    });
  } else {
    addTitle(slide, spec.title ?? '');
    const hasVisual = Boolean(spec.chart ?? spec.table) || spec.flow.length > 0;
    if (spec.bullets.length > 0) {
      addBullets(slide, spec.bullets, {
        x: 0.65,
        y: 1.65,
        w: hasVisual ? 5.4 : SLIDE.width - 1.3,
        h: hasVisual ? 4.9 : 5.1,
      });
    }
    if (spec.chart) {
      addChart(slide, pptx, spec.chart, { x: 6.3, y: 1.65, w: 6.35, h: 4.9 });
    } else if (spec.table) {
      addTable(slide, spec.table, { x: 6.3, y: 1.65, w: 6.35, h: 4.9 });
    } else if (spec.flow.length > 0) {
      addFlow(slide, spec.flow, { x: 6.3, y: 1.7, w: 6.35, h: 4.8 });
    } else if (spec.columns.length > 0) {
      spec.columns.slice(0, 2).forEach((column, index) => {
        addBullets(slide, column, {
          x: 0.65 + index * 6.15,
          y: 1.65,
          w: 5.7,
          h: 5.1,
        });
      });
    }
  }

  if (spec.subtitle && spec.layout === 'content') {
    slide.addText(spec.subtitle, {
      x: 0.65,
      y: 1.45,
      w: SLIDE.width - 1.3,
      h: 0.5,
      fontSize: 14,
      color: MUTED,
      fontFace: 'Calibri',
    });
  }
  if (spec.notes) slide.addNotes(spec.notes);
}

export async function renderPresentation(request: PresentationRequest): Promise<Buffer> {
  request.slides.forEach((slide) => {
    if (slide.chart) {
      if (slide.chart.series.some((series) => series.values.length !== slide.chart!.categories.length)) {
        throw new RangeError(
          `Chart "${slide.chart.title}" has mismatched categories and series lengths.`,
        );
      }
    }
    if (slide.layout === 'twoColumn' && slide.columns.length === 0) {
      throw new RangeError('A two-column slide needs at least one column of content.');
    }
  });

  const pptx = new PptxConstructor();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = request.author ?? 'Coderax Native';
  pptx.company = 'Coderax';
  pptx.title = request.title;
  pptx.subject = request.title;
  for (const spec of request.slides) addSlide(pptx, spec);

  const written = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(written as Uint8Array);
}

function xmlTexts(xml: string): string {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
    .map((match) =>
      (match[1] ?? '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    )
    .join(' ');
}

export type PresentationVerification = {
  ok: boolean;
  detail: string;
};

/** Reads the PPTX back and checks slide count, titles, charts and notes. */
export function verifyPresentation(
  buffer: Buffer,
  request: PresentationRequest,
): PresentationVerification {
  try {
    const entries = readZip(buffer);
    const slides = [...entries.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((left, right) => {
        const a = Number.parseInt(/(\d+)\.xml$/.exec(left)?.[1] ?? '0', 10);
        const b = Number.parseInt(/(\d+)\.xml$/.exec(right)?.[1] ?? '0', 10);
        return a - b;
      });
    if (slides.length !== request.slides.length) {
      return {
        ok: false,
        detail: `Expected ${request.slides.length} slides, found ${slides.length}.`,
      };
    }
    const chartParts = [...entries.keys()].filter((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    const expectedCharts = request.slides.filter((slide) => slide.chart).length;
    if (chartParts.length < expectedCharts) {
      return {
        ok: false,
        detail: `Expected ${expectedCharts} chart parts, found ${chartParts.length}.`,
      };
    }
    const notesParts = [...entries.keys()].filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name));
    const expectedNotes = request.slides.filter((slide) => slide.notes).length;
    if (notesParts.length < expectedNotes) {
      return {
        ok: false,
        detail: `Expected ${expectedNotes} notes parts, found ${notesParts.length}.`,
      };
    }
    for (const [index, part] of slides.entries()) {
      const spec = request.slides[index];
      if (!spec) continue;
      const xml = entries.get(part)?.toString('utf8') ?? '';
      const text = xmlTexts(xml);
      if (spec.title && !text.includes(spec.title)) {
        return {
          ok: false,
          detail: `Slide ${index + 1} does not contain its title.`,
        };
      }
      if (spec.chart && !/<p:graphicFrame>/.test(xml)) {
        return { ok: false, detail: `Slide ${index + 1} is missing its chart frame.` };
      }
    }
    return {
      ok: true,
      detail: `${slides.length} editable slides, ${chartParts.length} charts and ${notesParts.length} notes parts verified.`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `The presentation could not be reopened: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
}
