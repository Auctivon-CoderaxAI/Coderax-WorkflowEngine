import type { IsoDateTime } from '@coderax/contracts';

/**
 * Bounded, stable pagination without offsets.
 *
 * An offset page shifts when a row is written, which makes a client skip or
 * duplicate history while a task is running. The cursor is the last row's sort
 * position, encoded opaquely, and every list query has a hard page bound.
 */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 200;

export type PageCursor = {
  /** The sort timestamp of the last row. */
  at: IsoDateTime;
  /** The tie-break identifier. */
  id: string;
};

export function clampLimit(value: number | undefined, fallback = PAGE_DEFAULT): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(PAGE_MAX, Math.max(1, Math.floor(value)));
}

export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): PageCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { at, id } = parsed as { at?: unknown; id?: unknown };
    if (typeof at !== 'string' || at.length === 0 || typeof id !== 'string' || id.length === 0) {
      return null;
    }
    return { at, id };
  } catch {
    return null;
  }
}

/**
 * The filter that resumes after a cursor, expressed as an `$or` so the database
 * can use a compound index on `(timestamp, id)`.
 */
export function afterCursor(
  cursor: PageCursor | null,
  atField: string,
  idField: string,
  direction: 'asc' | 'desc',
): Record<string, unknown> {
  if (!cursor) return {};
  const operator = direction === 'desc' ? '$lt' : '$gt';
  return {
    $or: [
      { [atField]: { [operator]: cursor.at } },
      { [atField]: cursor.at, [idField]: { [operator]: cursor.id } },
    ],
  };
}
