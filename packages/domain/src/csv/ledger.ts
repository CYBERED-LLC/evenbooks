import { createHash } from 'node:crypto';
import { D, type Dec } from '../money/money';
import { CsvRowError, parseCsvAmount, parseCsvDate, type AmountColumns, type DateOrder } from './normalize';

/**
 * Column mapping for a general-ledger export (one row per journal line), as
 * produced by Wave's "accounting transactions" export, Xero's journal report,
 * QuickBooks' journal report or a spreadsheet.
 */
export interface LedgerCsvMapping {
  date: string;
  account: string;
  /** Transaction-level description; the first non-blank value in a transaction wins. */
  description?: string | null;
  /** Line-level memo. */
  memo?: string | null;
  reference?: string | null;
  /**
   * Column holding a transaction id that ties lines together. When null, rows
   * are grouped by `grouping`.
   */
  group?: string | null;
  /**
   * How to group rows without a transaction id column. `sequence`: in file
   * order, a transaction ends as soon as its lines balance (journal-ordered
   * exports). `date-description`: lines sharing a date and description belong
   * together wherever they sit in the file (per-account general-ledger
   * reports, such as Wave's, list each account's lines in its own section).
   */
  grouping?: LedgerGrouping | null;
  /**
   * Single signed amount (positive = debit unless `invert`) or separate
   * debit/credit columns.
   */
  amounts: AmountColumns;
  dateOrder: DateOrder;
}

export type LedgerGrouping = 'sequence' | 'date-description';

export interface LedgerCsvLine {
  rowNo: number;
  account: string;
  /** Non-negative decimal strings; exactly one side is non-zero. */
  debit: string;
  credit: string;
  memo: string | null;
}

export interface LedgerCsvEntry {
  /** Transaction id from the group column, or `row:<first row>` for file-order grouping. */
  key: string;
  date: string | null;
  description: string;
  reference: string | null;
  lines: LedgerCsvLine[];
  /** Every source row in the transaction, including zero-amount rows that produce no line. */
  rowNos: number[];
  error: string | null;
}

interface ParsedRow {
  rowNo: number;
  date: string;
  account: string;
  amount: Dec;
  description: string;
  memo: string | null;
  reference: string | null;
  group: string | null;
}

function cell(row: Record<string, string>, col: string | null | undefined): string {
  return col ? (row[col] ?? '').trim() : '';
}

/** Parse one ledger row. Throws CsvRowError; `amount` is signed, positive = debit. */
function parseLedgerRow(row: Record<string, string>, rowNo: number, m: LedgerCsvMapping): ParsedRow {
  const date = parseCsvDate(row[m.date], m.dateOrder);
  const account = cell(row, m.account);
  if (!account) throw new CsvRowError('account', 'Missing account');
  let amount: Dec;
  const cols = m.amounts;
  if (cols.amount) {
    const v = parseCsvAmount(row[cols.amount]);
    amount = new D(v ?? 0);
    if (cols.invert) amount = amount.negated();
  } else if (cols.debit || cols.credit) {
    // Ledger exports occasionally fill both sides of a line; the net is what posts.
    const debit = cols.debit ? parseCsvAmount(row[cols.debit]) : null;
    const credit = cols.credit ? parseCsvAmount(row[cols.credit]) : null;
    amount = new D(debit ?? 0).abs().minus(new D(credit ?? 0).abs());
  } else {
    throw new CsvRowError('amount', 'No amount column mapped');
  }
  return {
    rowNo,
    date,
    account,
    amount,
    description: cell(row, m.description),
    memo: cell(row, m.memo) || null,
    reference: cell(row, m.reference) || null,
    group: m.group ? cell(row, m.group) || null : null,
  };
}

function buildEntry(key: string, rows: ParsedRow[], extraRowNos: number[] = [], forcedError: string | null = null, description?: string): LedgerCsvEntry {
  const rowNos = [...rows.map((r) => r.rowNo), ...extraRowNos].sort((a, b) => a - b);
  const entryDescription = description ?? rows.find((r) => r.description)?.description ?? '';
  const lines: LedgerCsvLine[] = rows
    .filter((r) => !r.amount.isZero())
    .map((r) => ({
      rowNo: r.rowNo,
      account: r.account,
      debit: r.amount.isPositive() ? r.amount.toString() : '0',
      credit: r.amount.isNegative() ? r.amount.abs().toString() : '0',
      // A line whose own description differs from the transaction's keeps it as its memo.
      memo: r.memo ?? (r.description && r.description !== entryDescription ? r.description : null),
    }));
  const dates = new Set(rows.map((r) => r.date));
  let error = forcedError;
  if (!error && dates.size > 1) error = `Lines are dated ${[...dates].sort().join(', ')}; a transaction must have one date`;
  if (!error && lines.length < 2) error = lines.length === 0 ? 'No non-zero amounts' : 'Only one line; a transaction needs at least two';
  if (!error) {
    const debit = lines.reduce((t, l) => t.plus(l.debit), new D(0));
    const credit = lines.reduce((t, l) => t.plus(l.credit), new D(0));
    if (!debit.eq(credit)) error = `Debits ${debit.toFixed(2)} do not equal credits ${credit.toFixed(2)}`;
  }
  return {
    key,
    date: rows[0]?.date ?? null,
    description: entryDescription,
    reference: rows.find((r) => r.reference)?.reference ?? null,
    lines,
    rowNos,
    error,
  };
}

/**
 * Turn ledger rows into candidate journal entries. Pure: validation against
 * the chart of accounts, duplicates and closed periods happens in the service.
 * Row numbers are 1-based data rows (the header is row 0).
 */
export function groupLedgerRows(records: readonly Record<string, string>[], m: LedgerCsvMapping): LedgerCsvEntry[] {
  const entries: LedgerCsvEntry[] = [];
  if (m.group) {
    const groups = new Map<string, { rows: ParsedRow[]; bad: number[]; errors: string[] }>();
    const order: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const rowNo = i + 1;
      const raw = records[i]!;
      const id = cell(raw, m.group);
      if (!id) {
        entries.push(buildEntry(`row:${rowNo}`, [], [rowNo], `Row ${rowNo}: missing ${m.group}`));
        continue;
      }
      let g = groups.get(id);
      if (!g) {
        g = { rows: [], bad: [], errors: [] };
        groups.set(id, g);
        order.push(id);
      }
      try {
        g.rows.push(parseLedgerRow(raw, rowNo, m));
      } catch (err) {
        g.bad.push(rowNo);
        g.errors.push(`Row ${rowNo}: ${rowError(err)}`);
      }
    }
    for (const id of order) {
      const g = groups.get(id)!;
      entries.push(buildEntry(id, g.rows, g.bad, g.errors[0] ?? null));
    }
    return entries.sort((a, b) => a.rowNos[0]! - b.rowNos[0]!);
  }
  if (m.grouping === 'date-description') return groupByDateAndDescription(records, m);

  // File order: accumulate until the running total returns to zero.
  let open: ParsedRow[] = [];
  let zeroRows: number[] = [];
  let total = new D(0);
  const flush = (error: string | null, extra: number[] = []) => {
    if (open.length || extra.length || zeroRows.length) {
      const first = Math.min(...open.map((r) => r.rowNo), ...extra, ...zeroRows);
      entries.push(buildEntry(`row:${first}`, open, [...zeroRows, ...extra], error));
    }
    open = [];
    zeroRows = [];
    total = new D(0);
  };
  for (let i = 0; i < records.length; i++) {
    const rowNo = i + 1;
    let row: ParsedRow;
    try {
      row = parseLedgerRow(records[i]!, rowNo, m);
    } catch (err) {
      // A bad row poisons whatever transaction it sits in; start fresh after it.
      flush(`Row ${rowNo}: ${rowError(err)}`, [rowNo]);
      continue;
    }
    if (open.length && row.date !== open[0]!.date) flush(null);
    if (row.amount.isZero()) {
      if (open.length) zeroRows.push(rowNo);
      continue;
    }
    open.push(row);
    total = total.plus(row.amount);
    if (total.isZero() && open.length >= 2) flush(null);
  }
  flush(null);
  return entries;
}

function normalizeDescription(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when `long` is `short` followed by a separator, e.g. "Acme - 12" and "Acme - 12 - Hosting". */
function extendsDescription(short: string, long: string): boolean {
  return long.length > short.length && long.startsWith(short) && !/[a-z0-9]/i.test(long[short.length]!);
}

interface DescGroup {
  rows: ParsedRow[];
  desc: string;
  total: Dec;
}

/**
 * Per-account reports list each account's lines separately, so a
 * transaction's lines are scattered through the file. They share a date and,
 * usually, a description. Wave writes an invoice's receivable line as
 * "Customer - 12" and its sales lines as "Customer - 12 - Product", so groups
 * that do not balance are merged with same-day groups whose description
 * extends theirs. Whatever is still unbalanced on a day is merged into one
 * entry when it nets to zero; otherwise each group is reported as an error.
 */
function groupByDateAndDescription(records: readonly Record<string, string>[], m: LedgerCsvMapping): LedgerCsvEntry[] {
  const entries: LedgerCsvEntry[] = [];
  const byDate = new Map<string, Map<string, DescGroup>>();
  for (let i = 0; i < records.length; i++) {
    const rowNo = i + 1;
    let row: ParsedRow;
    try {
      row = parseLedgerRow(records[i]!, rowNo, m);
    } catch (err) {
      entries.push(buildEntry(`row:${rowNo}`, [], [rowNo], `Row ${rowNo}: ${rowError(err)}`));
      continue;
    }
    let groups = byDate.get(row.date);
    if (!groups) byDate.set(row.date, (groups = new Map()));
    const key = normalizeDescription(row.description);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { rows: [], desc: row.description, total: new D(0) }));
    g.rows.push(row);
    g.total = g.total.plus(row.amount);
  }

  for (const groups of byDate.values()) {
    let open = [...groups.values()].filter((g) => !g.total.isZero());
    // Shortest description first, so "Acme - 12" absorbs "Acme - 12 - Hosting".
    open.sort((a, b) => a.desc.length - b.desc.length);
    for (const g of open) {
      if (g.total.isZero() || g.rows.length === 0) continue;
      for (const other of open) {
        if (other === g || other.rows.length === 0 || other.total.isZero()) continue;
        if (extendsDescription(normalizeDescription(g.desc), normalizeDescription(other.desc))) {
          g.rows.push(...other.rows);
          g.total = g.total.plus(other.total);
          other.rows = [];
        }
      }
    }
    open = open.filter((g) => g.rows.length > 0 && !g.total.isZero());
    const leftoverTotal = open.reduce((t, g) => t.plus(g.total), new D(0));
    if (open.length >= 2 && leftoverTotal.isZero()) {
      const merged: DescGroup = { rows: open.flatMap((g) => g.rows), desc: open.map((g) => g.desc).filter(Boolean).join('; '), total: new D(0) };
      for (const g of open) g.rows = [];
      groups.set(`merged:${merged.rows[0]!.rowNo}`, merged);
    }
    for (const g of groups.values()) {
      if (g.rows.length === 0) continue;
      const first = Math.min(...g.rows.map((r) => r.rowNo));
      entries.push(buildEntry(`row:${first}`, g.rows, [], null, g.desc));
    }
  }
  return entries.sort((a, b) => a.rowNos[0]! - b.rowNos[0]!);
}

/**
 * Detect a report laid out in per-account sections (Wave's "Account
 * Transactions (General Ledger)" report, QuickBooks' General Ledger report):
 * a row naming the account, its lines, then "Starting Balance" / "Totals" /
 * "Balance Change" rows. Returns the rows flattened into one table with an
 * added `Account` column, or null when the file is not shaped that way.
 */
export function unfoldSectionedLedger(headers: readonly string[], records: readonly Record<string, string>[]): { headers: string[]; records: Record<string, string>[] } | null {
  const ACCOUNT_COL = 'Account';
  if (headers.includes(ACCOUNT_COL)) return null;
  const values = (r: Record<string, string>) => headers.map((h) => (r[h] ?? '').trim());
  const isSummary = (cells: string[]) => /^(starting|opening|beginning|closing|ending) balance$|^totals?( and ending balance)?$|^total for\b|^balance change$|^net (change|movement)$/i.test(cells[0] ?? '');
  const isSectionHeader = (cells: string[]) => {
    const filled = cells.filter(Boolean);
    return filled.length === 1 && !/^\d{4}-\d{2}-\d{2}|^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|^[-+$(]?\d[\d,]*\.?\d*\)?$/.test(filled[0]!);
  };
  let sections = 0;
  let summaries = 0;
  let firstKind: 'header' | 'other' | null = null;
  for (const r of records) {
    const cells = values(r);
    if (!cells.some(Boolean)) continue;
    const header = isSectionHeader(cells);
    if (header) sections++;
    else if (isSummary(cells)) summaries++;
    if (!firstKind) firstKind = header ? 'header' : 'other';
  }
  if (sections === 0 || summaries === 0 || firstKind !== 'header') return null;

  const out: Record<string, string>[] = [];
  let account = '';
  for (const r of records) {
    const cells = values(r);
    if (!cells.some(Boolean)) continue;
    if (isSectionHeader(cells)) {
      account = cells.find(Boolean)!;
      continue;
    }
    if (isSummary(cells)) continue;
    out.push({ [ACCOUNT_COL]: account, ...r });
  }
  return { headers: [ACCOUNT_COL, ...headers], records: out };
}

function rowError(err: unknown): string {
  return err instanceof CsvRowError ? `${err.field}: ${err.message}` : (err as Error).message;
}

/**
 * Content fingerprint of a ledger entry: date plus its lines (source account,
 * debit, credit), order-independent. `sequence` separates identical
 * transactions in one file; re-importing an overlapping export reproduces the
 * same fingerprints, so those entries are recognized as already imported.
 */
export function ledgerEntryFingerprint(entry: Pick<LedgerCsvEntry, 'date' | 'lines'>, sequence: number): string {
  const lines = entry.lines.map((l) => `${l.account.trim().toLowerCase()}|${new D(l.debit).toFixed(6)}|${new D(l.credit).toFixed(6)}`).sort();
  return createHash('sha256')
    .update([entry.date ?? '', ...lines, String(sequence)].join('\n'))
    .digest('hex');
}
