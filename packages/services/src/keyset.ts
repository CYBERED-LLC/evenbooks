import { and, asc, desc, eq, gt, lt, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { SortDirection } from '@evenbooks/contracts';

/**
 * Keyset (cursor) paging over a user-chosen sort column with the row id as the
 * tie-breaker, so pages never skip or repeat rows while data changes.
 */
export interface SortColumn<Row> {
  /**
   * Expression to order by; wrap nullable columns in coalesce so every row has a value.
   * Timestamps must be `date_trunc('milliseconds', …)`: rows come back as JS Dates (ms
   * precision), so a microsecond value would not round-trip through the cursor.
   */
  expr: SQL | AnyColumn;
  /** Postgres type for the cursor value parameter. */
  cast: 'date' | 'numeric' | 'text' | 'int' | 'timestamptz';
  /** The same value read from a fetched row (must match `expr`). */
  value(row: Row): string | number;
}

export type SortColumns<Row, K extends string> = Record<K, SortColumn<Row>>;

interface CursorPayload {
  sort: string;
  dir: SortDirection;
  value: string | number;
  id: string;
}

export function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify([p.sort, p.dir, p.value, p.id])).toString('base64url');
}

/** Decode a cursor made for this sort; anything else (another sort, an old format) starts from the top. */
export function decodeCursor(cursor: string | undefined | null, sort: string, dir: SortDirection): { value: string | number; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [s, d, value, id] = parsed as [unknown, unknown, unknown, unknown];
    if (s !== sort || d !== dir || typeof id !== 'string' || (typeof value !== 'string' && typeof value !== 'number')) return null;
    return { value, id };
  } catch {
    return null;
  }
}

export interface Keyset<Row> {
  /** Condition for rows after the cursor (undefined on the first page). */
  after: SQL | undefined;
  orderBy: SQL[];
  /** Cursor for the next page, given the rows fetched with `limit + 1`. */
  next(rows: Row[], limit: number): string | null;
}

export function keyset<Row, K extends string>(opts: {
  columns: SortColumns<Row, K>;
  sort: K;
  dir: SortDirection;
  idColumn: AnyColumn;
  idOf(row: Row): string;
  cursor?: string | null;
}): Keyset<Row> {
  const col = opts.columns[opts.sort];
  const cmp = opts.dir === 'asc' ? gt : lt;
  const order = opts.dir === 'asc' ? asc : desc;
  const expr = sql`${col.expr}`;
  const c = decodeCursor(opts.cursor, opts.sort, opts.dir);
  const v = c ? sql`${c.value}::${sql.raw(col.cast)}` : null;
  const after = c && v ? or(cmp(expr, v), and(eq(expr, v), cmp(opts.idColumn, c.id))) : undefined;
  return {
    after,
    orderBy: [order(expr), order(opts.idColumn)],
    next(rows, limit) {
      if (rows.length <= limit) return null;
      const last = rows[limit - 1];
      if (!last) return null;
      return encodeCursor({ sort: opts.sort, dir: opts.dir, value: col.value(last), id: opts.idOf(last) });
    },
  };
}
