import { createHash } from 'node:crypto';
import { D } from '../money/money';
import { fromParts, isPlainDate, type PlainDate } from '../dates/plain-date';

export type DateOrder = 'YMD' | 'MDY' | 'DMY';

export interface AmountColumns {
  /** Single signed amount column. Positive = money in unless `invert`. */
  amount?: string | null;
  /** Separate columns for money out / money in. */
  debit?: string | null;
  credit?: string | null;
  /** Some exports show money out as positive; invert flips the sign of `amount`. */
  invert?: boolean;
}

export interface CsvMapping {
  date: string;
  description: string;
  memo?: string | null;
  reference?: string | null;
  amounts: AmountColumns;
  dateOrder: DateOrder;
}

export class CsvRowError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CsvRowError';
  }
}

/**
 * Parse an amount cell such as "$1,234.56", "(123.45)", "-123.45", "123.45-",
 * "123.45 CR" / "123.45 DR". Returns a decimal string with sign applied, or null for blank.
 * A trailing CR marker is treated as a negation of the DR default.
 */
export function parseCsvAmount(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let s = raw.trim();
  if (s === '' || s === '-') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bCR\b/i.test(s)) {
    negative = !negative;
    s = s.replace(/\bCR\b/i, '');
  } else if (/\bDR\b/i.test(s)) {
    s = s.replace(/\bDR\b/i, '');
  }
  s = s.replace(/[,\s$]/g, '');
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!/^\d*\.?\d+$/.test(s) && !/^\d+\.?$/.test(s)) {
    throw new CsvRowError('amount', `Unparseable amount "${raw}"`);
  }
  const d = new D(s);
  return (negative ? d.negated() : d).toString();
}

/** Parse a date in common formats to YYYY-MM-DD. */
export function parseCsvDate(raw: string | null | undefined, order: DateOrder): PlainDate {
  const s = (raw ?? '').trim();
  if (!s) throw new CsvRowError('date', 'Missing date');
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s);
  if (iso) {
    const d = fromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (isPlainDate(d)) return d;
    throw new CsvRowError('date', `Invalid date "${raw}"`);
  }
  const m = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[T ].*)?$/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new CsvRowError('date', `Unparseable date "${raw}"`);
    const dt = new Date(t);
    return fromParts(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  let year: number;
  let month: number;
  let day: number;
  if (m[1]!.length === 4) {
    year = a;
    month = b;
    day = c;
  } else {
    year = c < 100 ? 2000 + c : c;
    if (order === 'DMY') {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
  }
  const d = fromParts(year, month, day);
  if (!isPlainDate(d)) throw new CsvRowError('date', `Invalid date "${raw}"`);
  return d;
}

export function normalizeDescription(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export interface NormalizedCsvRow {
  date: PlainDate;
  /** Signed amount, positive = money into the account. */
  amount: string;
  description: string;
  memo: string | null;
  reference: string | null;
}

export function normalizeCsvRow(row: Record<string, string>, mapping: CsvMapping): NormalizedCsvRow {
  const date = parseCsvDate(row[mapping.date], mapping.dateOrder);
  const description = (row[mapping.description] ?? '').trim();
  const memo = mapping.memo ? (row[mapping.memo] ?? '').trim() || null : null;
  const reference = mapping.reference ? (row[mapping.reference] ?? '').trim() || null : null;
  let amount: string | null = null;
  const cols = mapping.amounts;
  if (cols.amount) {
    amount = parseCsvAmount(row[cols.amount]);
    if (amount !== null && cols.invert) amount = new D(amount).negated().toString();
  } else if (cols.debit || cols.credit) {
    const debit = cols.debit ? parseCsvAmount(row[cols.debit]) : null;
    const credit = cols.credit ? parseCsvAmount(row[cols.credit]) : null;
    if (debit !== null && credit !== null && !new D(debit).isZero() && !new D(credit).isZero()) {
      throw new CsvRowError('amount', 'Row has both a debit and a credit amount');
    }
    if (debit !== null && !new D(debit).isZero()) amount = new D(debit).abs().negated().toString();
    else if (credit !== null) amount = new D(credit).abs().toString();
    else if (debit !== null) amount = '0';
  } else {
    throw new CsvRowError('amount', 'No amount column mapped');
  }
  if (amount === null) throw new CsvRowError('amount', 'Missing amount');
  if (!description && !memo) throw new CsvRowError('description', 'Missing description');
  return { date, amount: new D(amount).toString(), description, memo, reference };
}

/**
 * Stable fingerprint for duplicate detection. `sequence` distinguishes
 * legitimately identical rows within one file (e.g. two identical coffees on
 * the same day) so they survive as distinct transactions, while re-importing
 * the same file reproduces the same fingerprints and is detected as a replay.
 */
export function rowFingerprint(
  bankAccountId: string,
  row: Pick<NormalizedCsvRow, 'date' | 'amount' | 'description'>,
  sequence: number,
): string {
  const h = createHash('sha256');
  h.update(
    [bankAccountId, row.date, new D(row.amount).toFixed(6), normalizeDescription(row.description), String(sequence)].join(
      '',
    ),
  );
  return h.digest('hex');
}
