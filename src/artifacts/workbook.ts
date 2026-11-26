import { createRequire } from 'node:module';
import type { ChartSpec, ColumnSpec, SheetRequest, SpreadsheetRequest } from '@coderax/contracts';
import { partText, readZip, writeZip, type ZipEntry } from './zip.js';

const require = createRequire(import.meta.url);
const Excel = require('exceljs') as typeof import('exceljs');

/**
 * XLSX generation with formulas, structured tables, typed columns and native
 * worksheet charts.
 *
 * ExcelJS writes the workbook; the DrawingML chart parts that ExcelJS does not
 * support are added here as real OOXML parts (chart, drawing, relationships and
 * content-type overrides), not as a picture of a chart. Verification reloads the
 * file with ExcelJS and inspects the chart parts, so a workbook that lost its
 * formulas or charts fails the request.
 */

export type WorkbookBuild = {
  buffer: Buffer;
  sheets: number;
  formulas: number;
  tables: number;
  charts: number;
};

function formatFor(column: ColumnSpec): string | undefined {
  switch (column.type) {
    case 'number':
      return '#,##0.00';
    case 'currency':
      return '"$"#,##0.00';
    case 'percent':
      return '0.00%';
    case 'date':
      return 'yyyy-mm-dd';
    default:
      return undefined;
  }
}

function cellValue(column: ColumnSpec, value: string | number | null): string | number | Date | null {
  if (value === null) return null;
  if (column.type === 'date' && typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed;
  }
  return value;
}

function validateSheet(sheet: SheetRequest): void {
  const width = sheet.columns.length;
  sheet.rows.forEach((row, index) => {
    if (row.length > width) {
      throw new RangeError(
        `Row ${index + 1} of "${sheet.name}" has ${row.length} cells but only ${width} columns are defined.`,
      );
    }
  });
  for (const chart of sheet.charts) {
    validateChart(chart);
  }
}

export function validateChart(chart: ChartSpec): void {
  if (chart.categories.length > 200) {
    throw new RangeError('A chart may have at most 200 categories.');
  }
  for (const series of chart.series) {
    if (series.values.length !== chart.categories.length) {
      throw new RangeError(
        `Chart "${chart.title}" has ${chart.categories.length} categories but series "${series.name}" has ${series.values.length} values.`,
      );
    }
  }
}

export async function renderWorkbook(request: SpreadsheetRequest): Promise<WorkbookBuild> {
  request.sheets.forEach(validateSheet);

  const wb = new Excel.Workbook();
  wb.creator = request.author ?? 'Coderax Native';
  wb.title = request.title;
  wb.created = new Date(Date.UTC(2026, 0, 1));
  wb.modified = new Date(Date.UTC(2026, 0, 1));

  let formulas = 0;
  let tables = 0;
  let charts = 0;

  request.sheets.forEach((sheet, sheetIndex) => {
    const ws = wb.addWorksheet(sheet.name, {
      views: sheet.freezeHeader ? [{ state: 'frozen', ySplit: 1, xSplit: 0 }] : [],
      properties: { defaultRowHeight: 18 },
    });
    ws.columns = sheet.columns.map((column) => ({
      header: column.header,
      width: column.width ?? Math.min(40, Math.max(12, column.header.length + 4)),
    }));
    sheet.columns.forEach((column, index) => {
      const numFmt = formatFor(column);
      if (numFmt) ws.getColumn(index + 1).numFmt = numFmt;
      ws.getColumn(index + 1).alignment = {
        vertical: 'middle',
        horizontal: column.type === 'text' || column.type === 'date' ? 'left' : 'right',
      };
    });

    const rows = sheet.rows.map((row) =>
      sheet.columns.map((column, columnIndex) => cellValue(column, row[columnIndex] ?? null)),
    );

    if (sheet.table && rows.length > 0) {
      const name = `CoderaxTable${sheetIndex + 1}`;
      ws.addTable({
        name,
        ref: 'A1',
        headerRow: true,
        totalsRow: false,
        style: { theme: 'TableStyleMedium2', showRowStripes: true },
        columns: sheet.columns.map((column) => ({ name: column.header, filterButton: true })),
        rows,
      });
      tables += 1;
    } else {
      ws.addRow(sheet.columns.map((column) => column.header));
      for (const row of rows) ws.addRow(row);
    }
    ws.getRow(1).font = { bold: true, size: 11 };
    ws.getRow(1).height = 20;

    const declared = new Map<string, string>();
    const totalRow = rows.length + 2;
    if (rows.length > 0 && sheet.columns.some((column) => column.total)) {
      const labelCell = ws.getRow(totalRow).getCell(1);
      labelCell.value = 'Total';
      labelCell.font = { bold: true };
      sheet.columns.forEach((column, index) => {
        if (!column.total) return;
        const columnLetter = ws.getColumn(index + 1).letter;
        const reference = sheet.table
          ? `SUBTOTAL(109,CoderaxTable${sheetIndex + 1}[${column.header}])`
          : `SUBTOTAL(109,${columnLetter}2:${columnLetter}${rows.length + 1})`;
        declared.set(`${columnLetter}${totalRow}`, reference);
        ws.getRow(totalRow).getCell(index + 1).font = { bold: true };
      });
      ws.getRow(totalRow).height = 20;
    }

    // An explicitly declared formula wins over the generated total for that cell.
    for (const formula of sheet.formulas) declared.set(formula.cell, formula.formula);
    for (const [cell, formula] of declared) {
      ws.getCell(cell).value = { formula };
    }
    formulas += declared.size;

    charts += sheet.charts.length;
  });

  const written = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const withCharts = charts > 0 ? addWorksheetCharts(written, request) : written;
  return { buffer: withCharts, sheets: request.sheets.length, formulas, tables, charts };
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? match[1] ?? null : null;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function resolvePart(target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `xl/${target}`.split('/');
  const output: string[] = [];
  for (const part of parts) {
    if (part === '..') output.pop();
    else if (part !== '.') output.push(part);
  }
  return output.join('/');
}

function sheetParts(entries: Map<string, Buffer>): Map<string, string> {
  const workbook = partText(entries, 'xl/workbook.xml');
  const relationships = partText(entries, 'xl/_rels/workbook.xml.rels');
  const relTargets = new Map<string, string>();
  for (const match of relationships.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0];
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (id && target) relTargets.set(id, target);
  }
  const result = new Map<string, string>();
  for (const match of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const tag = match[0];
    const name = attribute(tag, 'name');
    const relId = attribute(tag, 'r:id');
    if (!name || !relId) continue;
    const target = relTargets.get(relId);
    if (target) result.set(name, resolvePart(target));
  }
  return result;
}

function seriesXml(series: { name: string; values: number[] }): string {
  const points = series.values
    .map((value, index) => `<c:pt idx="${index}"><c:v>${Number.isFinite(value) ? value : 0}</c:v></c:pt>`)
    .join('');
  return points;
}

function chartXml(spec: ChartSpec, chartIndex: number): string {
  const categories = spec.categories
    .map((category, index) => `<c:pt idx="${index}"><c:v>${xmlEscape(category)}</c:v></c:pt>`)
    .join('');
  const ser = spec.series
    .map(
      (series, index) => `<c:ser>
  <c:idx val="${index}"/><c:order val="${index}"/>
  <c:tx><c:v>${xmlEscape(series.name)}</c:v></c:tx>
  <c:cat><c:strLit><c:ptCount val="${spec.categories.length}"/>${categories}</c:strLit></c:cat>
  <c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${series.values.length}"/>${seriesXml(series)}</c:numLit></c:val>
</c:ser>`,
    )
    .join('');

  const axisOne = 50_000_000 + chartIndex * 10 + 1;
  const axisTwo = 50_000_000 + chartIndex * 10 + 2;
  const plot =
    spec.type === 'pie'
      ? `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`
      : spec.type === 'line'
        ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="${axisOne}"/><c:axId val="${axisTwo}"/></c:lineChart>`
        : `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="80"/><c:axId val="${axisOne}"/><c:axId val="${axisTwo}"/></c:barChart>`;

  const axes =
    spec.type === 'pie'
      ? ''
      : `<c:catAx><c:axId val="${axisOne}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${axisTwo}"/></c:catAx>
<c:valAx><c:axId val="${axisTwo}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="${axisOne}"/></c:valAx>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart>
<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${xmlEscape(spec.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/>
<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>
<c:legend><c:legendPos val="${spec.type === 'pie' ? 'r' : 'b'}"/><c:overlay val="0"/></c:legend>
<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/>
</c:chart>
</c:chartSpace>`;
}

function drawingXml(charts: ChartSpec[], anchorColumn: number): string {
  const anchors = charts
    .map(
      (_, index) => `<xdr:twoCellAnchor editAs="oneCell">
<xdr:from><xdr:col>${anchorColumn + index * 8}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>${anchorColumn + index * 8 + 7}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>19</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 2}" name="Chart ${index + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${index + 1}"/></a:graphicData></a:graphic>
</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
}

function relationships(items: Array<{ id: string; type: string; target: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      (item) =>
        `<Relationship Id="${item.id}" Type="${item.type}" Target="${item.target}"/>`,
    )
    .join('')}</Relationships>`;
}

const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

function addWorksheetCharts(buffer: Buffer, request: SpreadsheetRequest): Buffer {
  const entries = readZip(buffer);
  const parts = sheetParts(entries);
  let chartIndex = 0;
  let drawingIndex = 0;
  const overrides: string[] = [];

  request.sheets.forEach((sheet) => {
    if (sheet.charts.length === 0) return;
    const sheetPath = parts.get(sheet.name);
    if (!sheetPath) {
      throw new Error(`The generated workbook has no worksheet part for "${sheet.name}".`);
    }
    const sheetXml = partText(entries, sheetPath);
    const relsPath = sheetPath.replace(/([^/]+)$/, '_rels/$1.rels');
    const existingRels = entries.get(relsPath)?.toString('utf8');
    drawingIndex += 1;
    const drawingRelId = `rIdDr${drawingIndex}`;
    const drawingPath = `xl/drawings/drawing${drawingIndex}.xml`;
    const drawingRelsPath = `xl/drawings/_rels/drawing${drawingIndex}.xml.rels`;

    if (existingRels) {
      const base = existingRels.replace(/<\/Relationships>\s*$/, '');
      entries.set(
        relsPath,
        Buffer.from(
          `${base}<Relationship Id="${drawingRelId}" Type="${REL_DRAWING}" Target="../drawings/drawing${drawingIndex}.xml"/></Relationships>`,
          'utf8',
        ),
      );
    } else {
      entries.set(
        relsPath,
        Buffer.from(
          relationships([
            { id: drawingRelId, type: REL_DRAWING, target: `../drawings/drawing${drawingIndex}.xml` },
          ]),
          'utf8',
        ),
      );
    }

    const chartRelIds: string[] = [];
    sheet.charts.forEach((chart) => {
      chartIndex += 1;
      chartRelIds.push(`rId${chartRelIds.length + 1}`);
      entries.set(`xl/charts/chart${chartIndex}.xml`, Buffer.from(chartXml(chart, chartIndex), 'utf8'));
      overrides.push(
        `<Override PartName="/xl/charts/chart${chartIndex}.xml" ContentType="${CT_CHART}"/>`,
      );
    });
    entries.set(drawingPath, Buffer.from(drawingXml(sheet.charts, sheet.columns.length + 1), 'utf8'));
    entries.set(
      drawingRelsPath,
      Buffer.from(
        relationships(
          chartRelIds.map((id, index) => ({
            id,
            type: REL_CHART,
            target: `../charts/chart${chartIndex - sheet.charts.length + index + 1}.xml`,
          })),
        ),
        'utf8',
      ),
    );
    overrides.push(`<Override PartName="/${drawingPath}" ContentType="${CT_DRAWING}"/>`);

    const withDrawing = addDrawingElement(sheetXml, drawingRelId);
    entries.set(sheetPath, Buffer.from(withDrawing, 'utf8'));
  });

  const contentTypesPath = '[Content_Types].xml';
  const contentTypes = partText(entries, contentTypesPath);
  entries.set(
    contentTypesPath,
    Buffer.from(contentTypes.replace('</Types>', `${overrides.join('')}</Types>`), 'utf8'),
  );

  const output: ZipEntry[] = [...entries.entries()].map(([name, data]) => ({ name, data }));
  return writeZip(output);
}

function addDrawingElement(sheetXml: string, relId: string): string {
  const withNamespace = sheetXml.includes('xmlns:r=')
    ? sheetXml
    : sheetXml.replace(/<worksheet\b([^>]*)>/, '<worksheet$1 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');
  const element = `<drawing r:id="${relId}"/>`;
  // CT_Worksheet orders `drawing` before `tableParts` and `extLst`.
  if (withNamespace.includes('<tableParts')) {
    return withNamespace.replace('<tableParts', `${element}<tableParts`);
  }
  if (withNamespace.includes('<extLst')) {
    return withNamespace.replace('<extLst', `${element}<extLst`);
  }
  return withNamespace.replace('</worksheet>', `${element}</worksheet>`);
}

export type WorkbookVerification = {
  ok: boolean;
  detail: string;
};

/** Reopens the workbook and checks the structures that were requested. */
export async function verifyWorkbook(
  buffer: Buffer,
  request: SpreadsheetRequest,
): Promise<WorkbookVerification> {
  try {
    const entries = readZip(buffer);
    if (!entries.has('[Content_Types].xml')) {
      return { ok: false, detail: 'The workbook has no content-types part.' };
    }
    const reloaded = new Excel.Workbook();
    await reloaded.xlsx.load(buffer as unknown as ArrayBuffer);
    if (reloaded.worksheets.length !== request.sheets.length) {
      return {
        ok: false,
        detail: `Expected ${request.sheets.length} worksheets, found ${reloaded.worksheets.length}.`,
      };
    }
    const chartParts = [...entries.keys()].filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name));
    const expectedCharts = request.sheets.reduce((total, sheet) => total + sheet.charts.length, 0);
    if (chartParts.length !== expectedCharts) {
      return {
        ok: false,
        detail: `Expected ${expectedCharts} chart parts, found ${chartParts.length}.`,
      };
    }
    for (const sheet of request.sheets) {
      const worksheet = reloaded.getWorksheet(sheet.name);
      if (!worksheet) return { ok: false, detail: `Worksheet "${sheet.name}" is missing.` };
      const expectedRows = sheet.rows.length + 1;
      if (worksheet.rowCount < expectedRows) {
        return {
          ok: false,
          detail: `Worksheet "${sheet.name}" has ${worksheet.rowCount} rows, expected at least ${expectedRows}.`,
        };
      }
      for (const formula of sheet.formulas) {
        const value = worksheet.getCell(formula.cell).value as { formula?: string } | null;
        if (!value || value.formula !== formula.formula) {
          return {
            ok: false,
            detail: `Formula ${formula.formula} was not preserved in cell ${formula.cell}.`,
          };
        }
      }
    }
    for (const part of chartParts) {
      const xml = partText(entries, part);
      if (!/<c:(barChart|lineChart|pieChart)>/.test(xml)) {
        return { ok: false, detail: `${part} does not contain a chart definition.` };
      }
    }
    return {
      ok: true,
      detail: `${reloaded.worksheets.length} worksheets, ${chartParts.length} native charts and all formulas reloaded.`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `The workbook could not be reopened: ${error instanceof Error ? error.message : 'unknown error'}.`,
    };
  }
}
