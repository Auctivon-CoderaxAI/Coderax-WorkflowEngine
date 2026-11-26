import type {
  DatasetField,
  DatasetProfile,
  DatasetRequest,
  TransformStep,
} from '@coderax/contracts';

/**
 * Dataset intelligence without a database, a dataframe library or a model.
 *
 * The parser produces a typed table; every transformation is a declared step, not
 * executable text; the recipe (source digest + steps) is persisted so the same
 * analysis can be replayed. Statistics are computed from the actual values that
 * survive the pipeline, which is what the report and the verification read.
 */

export type DataValue = string | number | boolean | null;
export type ColumnType = DatasetField['type'];

export type DataTable = {
  columns: string[];
  rows: Array<Record<string, DataValue>>;
};

export type TypedColumn = {
  name: string;
  type: ColumnType;
};

export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => !(entry.length === 1 && entry[0]?.trim() === ''));
}

function normalizeValue(value: unknown): DataValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  return JSON.stringify(value);
}

function isNumeric(value: DataValue): boolean {
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  return value.trim().length > 0 && Number.isFinite(Number(value));
}

function isDateLike(value: DataValue): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function inferType(values: DataValue[]): ColumnType {
  const present = values.filter((value): value is NonNullable<DataValue> => value !== null);
  if (present.length === 0) return 'empty';
  if (present.every((value) => isNumeric(value))) return 'number';
  if (present.every((value) => isDateLike(value))) return 'date';
  if (present.every((value) => typeof value === 'boolean' || value === 'true' || value === 'false')) {
    return 'boolean';
  }
  return 'string';
}

function coerceNumber(value: DataValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && isNumeric(value)) return Number(value);
  return null;
}

/** CSV/TSV headers become columns; JSON keys are unioned in first-seen order. */
export function parseDataset(text: string, format: 'csv' | 'tsv' | 'json'): DataTable {
  if (format === 'csv' || format === 'tsv') {
    const label = format === 'tsv' ? 'TSV' : 'CSV';
    const raw = parseCsv(text, format === 'tsv' ? '\t' : ',');
    if (raw.length < 2) {
      throw new RangeError(`A ${label} dataset needs a header row and at least one data row.`);
    }
    const headers = (raw[0] ?? []).map((header, index) => {
      const name = header.trim();
      return name.length > 0 ? name : `column_${index + 1}`;
    });
    if (new Set(headers).size !== headers.length) {
      throw new RangeError(`${label} headers must be unique.`);
    }
    const records = raw.slice(1).map((row) => {
      const record: Record<string, DataValue> = {};
      headers.forEach((header, index) => {
        record[header] = normalizeValue(row[index] ?? null);
      });
      return record;
    });
    const columns = headers.map((name) => {
      const values = records.map((record) => record[name] ?? null);
      const type = inferType(values);
      if (type === 'number') {
        for (const record of records) record[name] = coerceNumber(record[name] ?? null);
      }
      return { name, type };
    });
    return finalize(columns, records);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RangeError('The dataset is not valid JSON.');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { rows?: unknown }).rows)
      ? ((parsed as { rows: unknown[] }).rows)
      : null;
  if (!list) {
    throw new RangeError('A JSON dataset must be an array of objects or an object with a rows array.');
  }
  const records: Array<Record<string, DataValue>> = [];
  const names: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new RangeError('Every JSON dataset row must be an object.');
    }
    const record: Record<string, DataValue> = {};
    for (const [key, value] of Object.entries(entry)) {
      if (!names.includes(key)) names.push(key);
      record[key] = normalizeValue(value);
    }
    records.push(record);
  }
  if (records.length === 0) {
    throw new RangeError('A JSON dataset needs at least one row.');
  }
  const columns = names.map((name) => {
    const values = records.map((record) => record[name] ?? null);
    const type = inferType(values);
    if (type === 'number') {
      for (const record of records) record[name] = coerceNumber(record[name] ?? null);
    }
    return { name, type };
  });
  return finalize(columns, records);
}

function finalize(columns: TypedColumn[], rows: Array<Record<string, DataValue>>): DataTable {
  return { columns: columns.map((column) => column.name), rows };
}

function requireColumn(table: DataTable, name: string): void {
  if (!table.columns.includes(name)) {
    throw new RangeError(`The dataset has no column named "${name}".`);
  }
}

function compare(left: DataValue, right: DataValue): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const leftNumber = coerceNumber(left);
  const rightNumber = coerceNumber(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right), 'en', { numeric: true });
}

function matches(
  value: DataValue,
  operator: Extract<TransformStep, { op: 'filter' }>['operator'],
  expected: string | number | boolean | Array<string | number>,
): boolean {
  switch (operator) {
    case 'eq':
      return typeof expected === 'number'
        ? coerceNumber(value) === expected
        : `${value ?? ''}` === `${expected}`;
    case 'ne':
      return !matches(value, 'eq', expected);
    case 'gt':
      return compare(value, expected as DataValue) > 0;
    case 'gte':
      return compare(value, expected as DataValue) >= 0;
    case 'lt':
      return compare(value, expected as DataValue) < 0;
    case 'lte':
      return compare(value, expected as DataValue) <= 0;
    case 'contains':
      return `${value ?? ''}`.toLowerCase().includes(`${expected}`.toLowerCase());
    case 'in':
      return Array.isArray(expected)
        ? expected.some((candidate) =>
            typeof candidate === 'number' ? coerceNumber(value) === candidate : `${value ?? ''}` === candidate,
          )
        : false;
    case 'notEmpty':
      return value !== null && `${value}`.length > 0;
  }
}

/* ------------------------------------------------------------------ */
/* A safe arithmetic expression evaluator for the `derive` step.        */
/* ------------------------------------------------------------------ */

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '[') {
      const end = expression.indexOf(']', index);
      if (end < 0) throw new RangeError('A derived column has an unclosed column reference.');
      tokens.push({ kind: 'name', value: expression.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (/[0-9.]/.test(character)) {
      const match = /^[0-9]+(?:\.[0-9]+)?/.exec(expression.slice(index));
      if (!match) throw new RangeError('A derived column has an invalid number.');
      tokens.push({ kind: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index));
      if (!match) throw new RangeError('A derived column has an invalid identifier.');
      tokens.push({ kind: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    if ('+-*/(),'.includes(character)) {
      tokens.push({ kind: 'op', value: character });
      index += 1;
      continue;
    }
    throw new RangeError(`A derived column contains an unsupported character "${character}".`);
  }
  return tokens;
}

const FUNCTIONS: Record<string, (values: number[]) => number> = {
  abs: (values) => Math.abs(values[0] ?? 0),
  round: (values) => {
    const digits = Math.min(6, Math.max(0, Math.trunc(values[1] ?? 0)));
    return Number((values[0] ?? 0).toFixed(digits));
  },
  floor: (values) => Math.floor(values[0] ?? 0),
  ceil: (values) => Math.ceil(values[0] ?? 0),
  min: (values) => Math.min(...values),
  max: (values) => Math.max(...values),
};

export function evaluateExpression(
  expression: string,
  row: Record<string, DataValue>,
): number | null {
  const tokens = tokenize(expression);
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const take = (): Token => {
    const token = tokens[position];
    if (!token) throw new RangeError('A derived column expression is incomplete.');
    position += 1;
    return token;
  };
  const accept = (value: string): boolean => {
    const token = peek();
    if (token && token.kind === 'op' && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };

  const parsePrimary = (): number | null => {
    const token = take();
    if (token.kind === 'number') return token.value;
    if (token.kind === 'op' && token.value === '(') {
      const inner = parseExpression();
      if (!accept(')')) throw new RangeError('A derived column expression has an unclosed parenthesis.');
      return inner;
    }
    if (token.kind === 'op' && token.value === '-') {
      const value = parsePrimary();
      return value === null ? null : -value;
    }
    if (token.kind === 'name') {
      if (accept('(')) {
        const fn = FUNCTIONS[token.value.toLowerCase()];
        if (!fn) throw new RangeError(`The function "${token.value}" is not supported.`);
        const args: number[] = [];
        if (!accept(')')) {
          do {
            const value = parseExpression();
            if (value === null) throw new RangeError('A function argument is not numeric.');
            args.push(value);
          } while (accept(','));
          if (!accept(')')) throw new RangeError('A function call has an unclosed parenthesis.');
        }
        return fn(args);
      }
      const value = row[token.value] ?? null;
      return coerceNumber(value);
    }
    throw new RangeError('A derived column expression is not valid.');
  };

  const parseTerm = (): number | null => {
    let value = parsePrimary();
    for (;;) {
      if (accept('*')) {
        const right = parsePrimary();
        value = value === null || right === null ? null : value * right;
      } else if (accept('/')) {
        const right = parsePrimary();
        value = value === null || right === null || right === 0 ? null : value / right;
      } else {
        return value;
      }
    }
  };

  function parseExpression(): number | null {
    let value = parseTerm();
    for (;;) {
      if (accept('+')) {
        const right = parseTerm();
        value = value === null || right === null ? null : value + right;
      } else if (accept('-')) {
        const right = parseTerm();
        value = value === null || right === null ? null : value - right;
      } else {
        return value;
      }
    }
  }

  const result = parseExpression();
  if (position !== tokens.length) {
    throw new RangeError('A derived column expression has trailing tokens.');
  }
  return result === null || !Number.isFinite(result) ? null : result;
}

function cloneRows(table: DataTable): Array<Record<string, DataValue>> {
  return table.rows.map((row) => ({ ...row }));
}

export type PipelineResult = {
  table: DataTable;
  applied: string[];
};

export function applySteps(table: DataTable, steps: TransformStep[]): PipelineResult {
  let columns = [...table.columns];
  let rows = cloneRows(table);
  const applied: string[] = [];

  for (const step of steps) {
    switch (step.op) {
      case 'filter': {
        requireColumn({ columns, rows }, step.column);
        const before = rows.length;
        rows = rows.filter((row) => matches(row[step.column] ?? null, step.operator, step.value));
        applied.push(`filter ${step.column} ${step.operator} (${before} -> ${rows.length} rows)`);
        break;
      }
      case 'select': {
        for (const column of step.columns) requireColumn({ columns, rows }, column);
        columns = [...step.columns];
        rows = rows.map((row) => {
          const next: Record<string, DataValue> = {};
          for (const column of columns) next[column] = row[column] ?? null;
          return next;
        });
        applied.push(`select ${columns.join(', ')}`);
        break;
      }
      case 'rename': {
        requireColumn({ columns, rows }, step.from);
        if (columns.includes(step.to)) {
          throw new RangeError(`The column "${step.to}" already exists.`);
        }
        columns = columns.map((column) => (column === step.from ? step.to : column));
        rows = rows.map((row) => {
          const next: Record<string, DataValue> = {};
          for (const column of Object.keys(row)) {
            next[column === step.from ? step.to : column] = row[column] ?? null;
          }
          return next;
        });
        applied.push(`rename ${step.from} to ${step.to}`);
        break;
      }
      case 'derive': {
        for (const row of rows) {
          row[step.column] = evaluateExpression(step.expression, row);
        }
        if (!columns.includes(step.column)) columns = [...columns, step.column];
        applied.push(`derive ${step.column} = ${step.expression}`);
        break;
      }
      case 'sort': {
        requireColumn({ columns, rows }, step.column);
        const direction = step.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort((left, right) => direction * compare(left[step.column] ?? null, right[step.column] ?? null));
        applied.push(`sort ${step.column} ${step.direction}`);
        break;
      }
      case 'groupBy': {
        for (const column of step.columns) requireColumn({ columns, rows }, column);
        for (const aggregate of step.aggregates) {
          if (aggregate.fn !== 'count') requireColumn({ columns, rows }, aggregate.column);
        }
        const groups = new Map<string, Array<Record<string, DataValue>>>();
        for (const row of rows) {
          const key = JSON.stringify(step.columns.map((column) => row[column] ?? null));
          const group = groups.get(key);
          if (group) group.push(row);
          else groups.set(key, [row]);
        }
        const outputColumns = [
          ...step.columns,
          ...step.aggregates.map((aggregate) => aggregate.as ?? `${aggregate.fn}_${aggregate.column}`),
        ];
        rows = [...groups.values()].map((group) => {
          const first = group[0] ?? {};
          const output: Record<string, DataValue> = {};
          for (const column of step.columns) output[column] = first[column] ?? null;
          for (const aggregate of step.aggregates) {
            const name = aggregate.as ?? `${aggregate.fn}_${aggregate.column}`;
            if (aggregate.fn === 'count') {
              output[name] = group.length;
              continue;
            }
            const values = group
              .map((row) => coerceNumber(row[aggregate.column] ?? null))
              .filter((value): value is number => value !== null);
            if (values.length === 0) {
              output[name] = null;
              continue;
            }
            const total = values.reduce((sum, value) => sum + value, 0);
            output[name] =
              aggregate.fn === 'sum'
                ? total
                : aggregate.fn === 'mean'
                  ? total / values.length
                  : aggregate.fn === 'min'
                    ? Math.min(...values)
                    : Math.max(...values);
          }
          return output;
        });
        columns = outputColumns;
        applied.push(`groupBy ${step.columns.join(', ')} (${rows.length} groups)`);
        break;
      }
      case 'dropMissing': {
        const target = step.columns.length > 0 ? step.columns : columns;
        for (const column of target) requireColumn({ columns, rows }, column);
        const before = rows.length;
        rows = rows.filter((row) => target.every((column) => row[column] !== null && row[column] !== ''));
        applied.push(`dropMissing (${before} -> ${rows.length} rows)`);
        break;
      }
      case 'dedupe': {
        const target = step.columns.length > 0 ? step.columns : columns;
        for (const column of target) requireColumn({ columns, rows }, column);
        const seen = new Set<string>();
        const before = rows.length;
        rows = rows.filter((row) => {
          const key = JSON.stringify(target.map((column) => row[column] ?? null));
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        applied.push(`dedupe (${before} -> ${rows.length} rows)`);
        break;
      }
      case 'replace': {
        requireColumn({ columns, rows }, step.column);
        rows = rows.map((row) => ({
          ...row,
          [step.column]:
            row[step.column] === null || row[step.column] === undefined
              ? null
              : String(row[step.column]).split(step.find).join(step.replace),
        }));
        applied.push(`replace "${step.find}" in ${step.column}`);
        break;
      }
      case 'trim': {
        const target = step.columns.length > 0 ? step.columns : columns;
        for (const column of target) requireColumn({ columns, rows }, column);
        rows = rows.map((row) => {
          const next = { ...row };
          for (const column of target) {
            const value = next[column];
            if (typeof value === 'string') next[column] = value.trim();
          }
          return next;
        });
        applied.push(`trim ${target.join(', ')}`);
        break;
      }
      case 'cast': {
        requireColumn({ columns, rows }, step.column);
        rows = rows.map((row) => {
          const value = row[step.column] ?? null;
          if (step.type === 'number') return { ...row, [step.column]: coerceNumber(value) };
          if (step.type === 'string') {
            return { ...row, [step.column]: value === null ? null : String(value) };
          }
          const parsed = value === null ? null : new Date(String(value));
          return {
            ...row,
            [step.column]: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null,
          };
        });
        applied.push(`cast ${step.column} to ${step.type}`);
        break;
      }
    }
  }

  return { table: { columns, rows }, applied };
}

export function numericValues(table: DataTable, column: string): number[] {
  return table.rows
    .map((row) => coerceNumber(row[column] ?? null))
    .filter((value): value is number => value !== null);
}

export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle];
}

export function stdev(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function profileDataset(table: DataTable): DatasetProfile {
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const row of table.rows) {
    const key = JSON.stringify(table.columns.map((column) => row[column] ?? null));
    if (seen.has(key)) duplicateRows += 1;
    else seen.add(key);
  }
  const fields: DatasetField[] = table.columns.map((name) => {
    const raw = table.rows.map((row) => row[name] ?? null);
    const present = raw.filter((value) => value !== null && `${value}`.length > 0);
    const numbers = raw
      .map((value) => coerceNumber(value))
      .filter((value): value is number => value !== null);
    const type = inferType(raw);
    return {
      name,
      type,
      missing: raw.length - present.length,
      unique: new Set(present.map((value) => JSON.stringify(value))).size,
      ...(numbers.length > 0
        ? {
            min: Math.min(...numbers),
            max: Math.max(...numbers),
            mean: numbers.reduce((sum, value) => sum + value, 0) / numbers.length,
            ...(median(numbers) !== undefined ? { median: median(numbers)! } : {}),
            ...(stdev(numbers) !== undefined ? { stdev: stdev(numbers)! } : {}),
          }
        : {}),
    };
  });
  return {
    rows: table.rows.length,
    columns: table.columns.length,
    duplicateRows,
    fields,
    sample: table.rows
      .slice(0, 10)
      .map((row) =>
        table.columns.map((column) => {
          const value = row[column] ?? null;
          return typeof value === 'boolean' ? String(value) : value;
        }),
      ),
  };
}

export function toCsv(table: DataTable, delimiter = ','): string {
  const escape = (value: DataValue): string => {
    if (value === null) return '';
    const text = String(value);
    const special = delimiter === '\t' ? /["\t\n\r]/ : /[",\n\r]/;
    return special.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [table.columns.map(escape).join(delimiter)];
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => escape(row[column] ?? null)).join(delimiter));
  }
  return `${lines.join('\n')}\n`;
}

export function toTsv(table: DataTable): string {
  return toCsv(table, '\t');
}

export function tableRowsForSheet(table: DataTable): Array<Array<string | number | null>> {
  return table.rows.map((row) =>
    table.columns.map((column) => {
      const value = row[column] ?? null;
      if (value === null) return null;
      if (typeof value === 'boolean') return String(value);
      return value;
    }),
  );
}

export function recipeFor(input: {
  request: DatasetRequest;
  sourceDigest: string;
  applied: string[];
}): Record<string, unknown> {
  return {
    version: 1,
    source: {
      format: input.request.source.format,
      digest: input.sourceDigest,
      bytes: Buffer.byteLength(input.request.source.text, 'utf8'),
    },
    steps: input.request.steps,
    applied: input.applied,
    charts: input.request.charts,
  };
}
