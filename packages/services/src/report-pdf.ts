import { and, eq } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import { renderReportPdf, type ReportPdfCell, type ReportPdfColumn, type ReportPdfDocument, type ReportPdfRow } from '@evenbooks/integrations';
import type { ServiceContext } from './context';
import { profitAndLoss, type Basis, type ReportLine } from './reports';
import { balanceSheet, categoryReport, generalLedger, outstandingInvoices, scheduleCSummary, transactionsReport, trialBalance, type CategoryReport } from './reports-more';

/**
 * PDF exports of the reports. Each builder runs the same service call as the
 * JSON/CSV route (whole range, never a page), lays the figures out the way the
 * screen does, and returns a renderer-agnostic document plus a file name that
 * matches the CSV's. Render with `renderReport` outside the database
 * transaction. Money is formatted for display only; every figure comes from
 * the report services, and differences use `Money`, never floats.
 */

export interface ReportPdf {
  fileName: string;
  document: ReportPdfDocument;
}

export interface ReportPdfOptions {
  /** Defaults to now; tests pin it. */
  generatedAt?: Date;
}

export function renderReport(r: ReportPdf): Promise<Buffer> {
  return renderReportPdf(r.document);
}

// ---------------------------------------------------------------------------
// Formatting (presentation only)
// ---------------------------------------------------------------------------
const moneyFormatters = new Map<string, Intl.NumberFormat>();

export function pdfMoney(value: string | null | undefined, currency: string): string {
  if (value === null || value === undefined || value === '') return '';
  let f = moneyFormatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
    moneyFormatters.set(currency, f);
  }
  const n = Number(value);
  return Number.isFinite(n) ? f.format(n) : value;
}

export function pdfDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function range(from: string, to: string): string {
  return `${pdfDate(from)} – ${pdfDate(to)}`;
}

function basisLabel(b: Basis): string {
  return b === 'cash' ? 'Cash basis' : 'Accrual basis';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

function isZero(v: string): boolean {
  return /^-?0+(\.0+)?$/.test(v);
}

function base(s: ServiceContext, title: string, subtitle: string[], opts: ReportPdfOptions, orientation: 'portrait' | 'landscape' = 'portrait') {
  const generatedAt = opts.generatedAt ?? new Date();
  let when: string;
  try {
    when = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: s.company.timeZone }).format(generatedAt);
  } catch {
    when = generatedAt.toISOString();
  }
  return { companyName: s.company.name, title, subtitle, generatedAt, generatedLine: `Generated ${when} (${s.company.timeZone}) by Evenbooks`, orientation };
}

// ---------------------------------------------------------------------------
// Comparison helpers (mirror the screen's compare columns)
// ---------------------------------------------------------------------------
interface MergedLine {
  code: string;
  name: string;
  amount: string | null;
  prior: string | null;
  count?: number;
}

function mergeLines<T extends ReportLine>(current: T[], prior: ReportLine[] | undefined): (MergedLine & { line: T | null })[] {
  const priorById = new Map((prior ?? []).map((l) => [l.accountId, l]));
  const out: (MergedLine & { line: T | null })[] = current.map((l) => ({ code: l.code, name: l.name, amount: l.amount, prior: priorById.get(l.accountId)?.amount ?? null, line: l }));
  if (!prior) return out;
  const seen = new Set(current.map((l) => l.accountId));
  const extra = prior.filter((l) => !seen.has(l.accountId));
  if (extra.length === 0) return out;
  for (const l of extra) out.push({ code: l.code, name: l.name, amount: null, prior: l.amount, line: null });
  return out.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }) || a.name.localeCompare(b.name));
}

/** Current minus prior. */
function change(current: string | null, prior: string | null, cur: string): string {
  return Money.of(current ?? '0', cur).subtract(Money.of(prior ?? '0', cur)).toString();
}

/** Percent change against the prior amount's magnitude ("+12.5%"), or null when the prior is zero. */
export function pdfPercentChange(current: string | null, prior: string | null, cur: string): string | null {
  const p = Money.of(prior ?? '0', cur).toMinorUnits();
  if (p === 0n) return null;
  const diff = Money.of(current ?? '0', cur).toMinorUnits() - p;
  const abs = p < 0n ? -p : p;
  const scaled = diff * 1000n;
  const neg = scaled < 0n;
  const mag = neg ? -scaled : scaled;
  const tenths = (mag + abs / 2n) / abs;
  const sign = tenths === 0n ? '' : neg ? '-' : '+';
  return `${sign}${(tenths / 10n).toLocaleString('en-US')}.${tenths % 10n}%`;
}

const COMPARE_COLUMNS: ReportPdfColumn[] = [
  { header: 'Prior', weight: 1.5, align: 'right' },
  { header: 'Change', weight: 1.5, align: 'right' },
  { header: '%', weight: 0.9, align: 'right' },
];

function compareCells(on: boolean, current: string | null, prior: string | null, cur: string): ReportPdfCell[] {
  if (!on) return [];
  return [prior === null ? { text: '—', muted: true } : pdfMoney(prior, cur), pdfMoney(change(current, prior, cur), cur), pdfPercentChange(current, prior, cur) ?? { text: '—', muted: true }];
}

function accountRow(l: MergedLine, cur: string, compare: boolean, extra: ReportPdfCell[] = []): ReportPdfRow {
  const onlyPrior = l.amount === null;
  return {
    kind: 'line',
    muted: onlyPrior,
    cells: [{ text: l.code, muted: true }, l.name, ...extra, onlyPrior ? { text: '—', muted: true } : pdfMoney(l.amount, cur), ...compareCells(compare, l.amount, l.prior, cur)],
  };
}

function totalCells(label: string, labelSpan: number, amount: string, prior: string | null | undefined, compare: boolean, cur: string, extra: ReportPdfCell[] = []): ReportPdfCell[] {
  return [{ text: label, span: labelSpan }, ...extra, pdfMoney(amount, cur), ...compareCells(compare, amount, compare ? (prior ?? '0.00') : null, cur)];
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ---------------------------------------------------------------------------
// Profit & loss
// ---------------------------------------------------------------------------
export async function profitAndLossPdf(
  s: ServiceContext,
  params: { from: string; to: string; basis: Basis; compareFrom?: string; compareTo?: string },
  opts: ReportPdfOptions = {},
): Promise<ReportPdf> {
  const r = await profitAndLoss(s, params);
  const p = params.compareFrom && params.compareTo ? await profitAndLoss(s, { from: params.compareFrom, to: params.compareTo, basis: params.basis }) : undefined;
  const cmp = !!p;
  const cur = r.currency;
  const income = mergeLines(r.income, p?.income);
  const expenses = mergeLines(r.expenses, p?.expenses);
  const rows: ReportPdfRow[] = [];
  rows.push({ kind: 'section', label: 'Income' });
  if (income.length === 0) rows.push({ kind: 'empty', text: 'None' });
  for (const l of income) rows.push(accountRow(l, cur, cmp));
  rows.push({ kind: 'subtotal', cells: totalCells('Total income', 2, r.totalIncome, p?.totalIncome, cmp, cur) });
  rows.push({ kind: 'section', label: 'Expenses' });
  if (expenses.length === 0) rows.push({ kind: 'empty', text: 'None' });
  for (const l of expenses) rows.push(accountRow(l, cur, cmp));
  rows.push({ kind: 'subtotal', cells: totalCells('Total expenses', 2, r.totalExpenses, p?.totalExpenses, cmp, cur) });
  rows.push({ kind: 'total', cells: totalCells('Net income', 2, r.netIncome, p?.netIncome, cmp, cur) });
  if (r.basis === 'cash' && r.salesTaxCollected !== undefined) {
    rows.push({ kind: 'section', label: 'Not income' });
    rows.push({ kind: 'line', muted: true, cells: ['', 'Sales tax collected', pdfMoney(r.salesTaxCollected, cur), ...compareCells(cmp, r.salesTaxCollected, p?.salesTaxCollected ?? '0.00', cur)] });
  }
  const columns: ReportPdfColumn[] = [{ header: 'Code', weight: 1 }, { header: 'Account', weight: 4.5 }, { header: 'Amount', weight: 1.6, align: 'right' }, ...(cmp ? COMPARE_COLUMNS : [])];
  const subtitle = [range(r.from, r.to), basisLabel(r.basis)];
  if (p) subtitle.push(`Compared with ${range(p.from, p.to)}`);
  return {
    fileName: `profit-and-loss-${r.basis}-${r.from}-${r.to}.pdf`,
    document: { ...base(s, 'Profit & Loss', subtitle, opts), tables: [{ columns, rows }], notes: [r.note] },
  };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------
function fiscalYearStart(asOf: string, startMonth: number): string {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}-01`;
}

export async function balanceSheetPdf(s: ServiceContext, params: { asOf: string; compareAsOf?: string }, opts: ReportPdfOptions = {}): Promise<ReportPdf> {
  const r = await balanceSheet(s, { asOf: params.asOf });
  const p = params.compareAsOf ? await balanceSheet(s, { asOf: params.compareAsOf }) : undefined;
  const cmp = !!p;
  const cur = r.currency;
  const rows: ReportPdfRow[] = [];
  const section = (label: string, lines: ReportLine[], prior: ReportLine[] | undefined, none: boolean) => {
    rows.push({ kind: 'section', label });
    const merged = mergeLines(lines, prior);
    if (merged.length === 0 && none) rows.push({ kind: 'empty', text: 'None' });
    for (const l of merged) rows.push(accountRow(l, cur, cmp));
  };
  section('Assets', r.assets, p?.assets, true);
  rows.push({ kind: 'subtotal', cells: totalCells('Total assets', 2, r.totalAssets, p?.totalAssets, cmp, cur) });
  section('Liabilities', r.liabilities, p?.liabilities, true);
  rows.push({ kind: 'subtotal', cells: totalCells('Total liabilities', 2, r.totalLiabilities, p?.totalLiabilities, cmp, cur) });
  section('Equity', r.equity, p?.equity, false);
  const fyStart = fiscalYearStart(r.asOf, s.company.fiscalYearStartMonth);
  rows.push({ kind: 'line', cells: ['', 'Profit from earlier years', pdfMoney(r.retainedEarningsPriorYears, cur), ...compareCells(cmp, r.retainedEarningsPriorYears, p?.retainedEarningsPriorYears ?? null, cur)] });
  rows.push({ kind: 'line', cells: ['', { text: 'Profit this year so far', sub: `Since ${pdfDate(fyStart)}` }, pdfMoney(r.currentYearEarnings, cur), ...compareCells(cmp, r.currentYearEarnings, p?.currentYearEarnings ?? null, cur)] });
  rows.push({ kind: 'subtotal', cells: totalCells('Total equity', 2, r.totalEquity, p?.totalEquity, cmp, cur) });
  const le = Money.of(r.totalLiabilities, cur).add(Money.of(r.totalEquity, cur)).toString();
  const ple = p ? Money.of(p.totalLiabilities, cur).add(Money.of(p.totalEquity, cur)).toString() : null;
  rows.push({ kind: 'total', cells: totalCells('Total liabilities and equity', 2, le, ple, cmp, cur) });
  // The difference is always zero for consistent books, so it only shows when it is not.
  const inconsistent = !isZero(r.difference);
  if (inconsistent) rows.push({ kind: 'line', cells: [{ text: 'Difference (assets − liabilities − equity)', span: 2, tone: 'danger' }, { text: pdfMoney(r.difference, cur), tone: 'danger' }] });
  const columns: ReportPdfColumn[] = [{ header: 'Code', weight: 1 }, { header: 'Account', weight: 4.5 }, { header: 'Balance', weight: 1.6, align: 'right' }, ...(cmp ? COMPARE_COLUMNS : [])];
  const subtitle = [`As of ${pdfDate(r.asOf)}`, 'Accrual basis'];
  if (p) subtitle.push(`Compared with ${pdfDate(p.asOf)}`);
  return {
    fileName: `balance-sheet-${r.asOf}.pdf`,
    document: {
      ...base(s, 'Balance sheet', subtitle, opts),
      alerts: inconsistent ? [`The ledger is inconsistent: assets differ from liabilities plus equity by ${pdfMoney(r.difference, cur)}.`] : undefined,
      tables: [{ columns, rows }],
      notes: [r.note],
    },
  };
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------
export async function trialBalancePdf(s: ServiceContext, params: { asOf: string }, opts: ReportPdfOptions = {}): Promise<ReportPdf> {
  const r = await trialBalance(s, params);
  const cur = r.currency;
  const rows: ReportPdfRow[] = r.rows.map((x) => ({
    kind: 'line',
    cells: [{ text: x.code, muted: true }, x.name, { text: capitalize(x.type), muted: true }, pdfMoney(x.debit, cur), pdfMoney(x.credit, cur)],
  }));
  if (rows.length === 0) rows.push({ kind: 'empty', text: 'No accounts with activity or balances' });
  rows.push({ kind: 'total', cells: [{ text: 'Total', span: 3 }, pdfMoney(r.totalDebit, cur), pdfMoney(r.totalCredit, cur)] });
  const balanced = r.totalDebit === r.totalCredit;
  return {
    fileName: `trial-balance-${r.asOf}.pdf`,
    document: {
      ...base(s, 'Trial balance', [`As of ${pdfDate(r.asOf)}`, 'Accrual basis', balanced ? 'Debits equal credits' : 'Debits do not equal credits'], opts),
      alerts: balanced ? undefined : ['Debits do not equal credits.'],
      tables: [
        {
          columns: [
            { header: 'Code', weight: 0.8 },
            { header: 'Account', weight: 3 },
            { header: 'Type', weight: 1 },
            { header: 'Debit', weight: 1.4, align: 'right' },
            { header: 'Credit', weight: 1.4, align: 'right' },
          ],
          rows,
        },
      ],
      notes: [r.note],
    },
  };
}

// ---------------------------------------------------------------------------
// General ledger (every line in the range)
// ---------------------------------------------------------------------------
export async function generalLedgerPdf(s: ServiceContext, params: { accountId: string; from: string; to: string }, opts: ReportPdfOptions = {}): Promise<ReportPdf> {
  const r = await generalLedger(s, { ...params, all: true });
  const cur = r.currency;
  const rows: ReportPdfRow[] = [{ kind: 'line', muted: true, cells: [pdfDate(r.from), '', { text: 'Opening balance', span: 2, italic: true }, '', '', pdfMoney(r.opening, cur)] }];
  if (r.lines.length === 0) rows.push({ kind: 'empty', text: 'No postings to this account in the period.' });
  for (const l of r.lines) {
    rows.push({
      kind: 'line',
      cells: [
        pdfDate(l.date),
        { text: l.entryNumber === null ? '—' : String(l.entryNumber), muted: true },
        { text: l.memo || '(no memo)', sub: l.lineMemo && l.lineMemo !== l.memo ? l.lineMemo : undefined },
        { text: capitalize(l.sourceType), muted: true },
        l.debit !== '0.00' ? pdfMoney(l.debit, cur) : '',
        l.credit !== '0.00' ? pdfMoney(l.credit, cur) : '',
        pdfMoney(l.running, cur),
      ],
    });
  }
  rows.push({ kind: 'total', cells: [pdfDate(r.to), '', { text: 'Closing balance', span: 2 }, pdfMoney(r.totalDebit, cur), pdfMoney(r.totalCredit, cur), pdfMoney(r.closing, cur)] });
  const n = r.lines.length;
  return {
    fileName: `general-ledger-${safeName(r.code)}-${r.from}-${r.to}.pdf`,
    document: {
      ...base(s, 'General ledger', [`${r.code} ${r.name}`, capitalize(r.type), range(r.from, r.to), 'Accrual basis'], opts, 'landscape'),
      summary: [
        { label: 'Opening balance', value: pdfMoney(r.opening, cur), hint: pdfDate(r.from) },
        { label: 'Debits', value: pdfMoney(r.totalDebit, cur), hint: 'In this period' },
        { label: 'Credits', value: pdfMoney(r.totalCredit, cur), hint: 'In this period' },
        { label: 'Closing balance', value: pdfMoney(r.closing, cur), hint: pdfDate(r.to) },
      ],
      tables: [
        {
          columns: [
            { header: 'Date', weight: 1.1 },
            { header: '#', weight: 0.6 },
            { header: 'Memo', weight: 5 },
            { header: 'Source', weight: 1.7 },
            { header: 'Debit', weight: 1.3, align: 'right' },
            { header: 'Credit', weight: 1.3, align: 'right' },
            { header: 'Balance', weight: 1.4, align: 'right' },
          ],
          rows,
        },
      ],
      notes: [`${n} ${n === 1 ? 'posting' : 'postings'}. ${r.note}`],
    },
  };
}

// ---------------------------------------------------------------------------
// Category report
// ---------------------------------------------------------------------------
export async function categoryReportPdf(
  s: ServiceContext,
  params: { from: string; to: string; basis: Basis; compareFrom?: string; compareTo?: string },
  opts: ReportPdfOptions = {},
): Promise<ReportPdf> {
  const r = await categoryReport(s, params);
  const p = params.compareFrom && params.compareTo ? await categoryReport(s, { from: params.compareFrom, to: params.compareTo, basis: params.basis }) : undefined;
  const cmp = !!p;
  const cur = r.currency;
  const group = (d: CategoryReport | undefined, type: 'income' | 'expense') => d?.groups.find((g) => g.type === type);
  const rows: ReportPdfRow[] = [];
  for (const [type, title, totalLabel] of [
    ['income', 'Income', 'Total income'],
    ['expense', 'Expenses', 'Total expenses'],
  ] as const) {
    const g = group(r, type);
    const pg = group(p, type);
    const lines = mergeLines(g?.lines ?? [], cmp ? (pg?.lines ?? []) : undefined);
    rows.push({ kind: 'section', label: title });
    if (lines.length === 0) rows.push({ kind: 'empty', text: 'None' });
    for (const l of lines) rows.push(accountRow(l, cur, cmp, [{ text: String(l.line ? l.line.count : 0), muted: true }]));
    const count = (g?.lines ?? []).reduce((n, l) => n + l.count, 0);
    rows.push({ kind: 'subtotal', cells: totalCells(totalLabel, 2, g?.total ?? '0.00', pg?.total, cmp, cur, [String(count)]) });
  }
  rows.push({ kind: 'total', cells: totalCells('Net income', 3, r.netIncome, p?.netIncome, cmp, cur) });
  const alerts: string[] = [];
  if (!isZero(r.uncategorized.income)) alerts.push(`Uncategorized income: ${pdfMoney(r.uncategorized.income, cur)}. Categorize it from the review inbox so it lands on the right line.`);
  if (!isZero(r.uncategorized.expense)) alerts.push(`Uncategorized expenses: ${pdfMoney(r.uncategorized.expense, cur)}. Categorize them from the review inbox so they land on the right lines.`);
  const columns: ReportPdfColumn[] = [
    { header: 'Code', weight: 1 },
    { header: 'Category', weight: 3.8 },
    { header: 'Transactions', weight: 1.3, align: 'right' },
    { header: 'Amount', weight: 1.6, align: 'right' },
    ...(cmp ? COMPARE_COLUMNS : []),
  ];
  const subtitle = [range(r.from, r.to), basisLabel(r.basis)];
  if (p) subtitle.push(`Compared with ${range(p.from, p.to)}`);
  return {
    fileName: `categories-${r.basis}-${r.from}-${r.to}.pdf`,
    document: { ...base(s, 'Category report', subtitle, opts, cmp ? 'landscape' : 'portrait'), alerts: alerts.length ? alerts : undefined, tables: [{ columns, rows }], notes: [r.note] },
  };
}

// ---------------------------------------------------------------------------
// Schedule C summary
// ---------------------------------------------------------------------------
export async function scheduleCPdf(s: ServiceContext, params: { taxYear: number; basis: Basis }, opts: ReportPdfOptions = {}): Promise<ReportPdf> {
  const r = await scheduleCSummary(s, params);
  const cur = r.currency;
  const rows: ReportPdfRow[] = [];
  const lineRows = (l: (typeof r.lines)[number], muted = false) => {
    const zero = isZero(l.amount) && l.accounts.length === 0;
    rows.push({ kind: 'line', muted: zero || muted, cells: [{ text: l.code === 'excluded' ? '—' : l.code, muted: true }, { text: l.label, sub: l.note }, pdfMoney(l.amount, cur)] });
    for (const a of l.accounts) rows.push({ kind: 'line', muted: true, cells: ['', { text: `${a.code}  ${a.name}`, indent: 14 }, pdfMoney(a.amount, cur)] });
  };
  rows.push({ kind: 'section', label: 'Part I — Income' });
  for (const l of r.lines.filter((x) => x.part === 'income')) lineRows(l);
  rows.push({ kind: 'subtotal', cells: ['', 'Gross receipts (line 1 − line 2 + line 6)', pdfMoney(r.grossReceipts, cur)] });
  rows.push({ kind: 'section', label: 'Part II — Expenses' });
  for (const l of r.lines.filter((x) => x.part === 'expense')) lineRows(l);
  rows.push({ kind: 'subtotal', cells: ['', 'Total expenses', pdfMoney(r.totalExpenses, cur)] });
  rows.push({ kind: 'total', cells: ['', 'Tentative profit (gross receipts − total expenses)', pdfMoney(r.tentativeProfit, cur)] });
  const other = r.lines.filter((x) => x.part !== 'income' && x.part !== 'expense' && x.accounts.length > 0);
  if (other.length > 0) {
    rows.push({ kind: 'section', label: 'Not on Schedule C' });
    for (const l of other) lineRows(l, true);
  }
  if (r.unmapped.length > 0) {
    rows.push({ kind: 'section', label: 'Unmapped categories', tone: 'warning' });
    for (const a of r.unmapped) rows.push({ kind: 'line', cells: [{ text: a.code, muted: true }, a.name, pdfMoney(a.amount, cur)] });
  }
  const n = r.unmapped.length;
  const alerts = r.uncategorized.map((u) => `${pdfMoney(u.amount, cur)} of ${u.type} hasn't been sorted into a category yet. ${u.lineCode ? `It's included on line ${u.lineCode} (${u.lineLabel}) until you categorize it.` : 'It is not on any line until you categorize it.'}`);
  if (n > 0) alerts.push(`${n} ${n === 1 ? 'category is' : 'categories are'} not mapped to a Schedule C line. Their totals are listed at the end but excluded from every line.`);
  return {
    fileName: `schedule-c-${r.taxYear}-${r.basis}.pdf`,
    document: {
      ...base(s, 'Schedule C summary', [`Tax year ${r.taxYear}`, basisLabel(r.basis)], opts),
      alerts: alerts.length ? alerts : undefined,
      tables: [
        {
          columns: [
            { header: 'Line', weight: 0.8 },
            { header: 'Description', weight: 5.5 },
            { header: 'Amount', weight: 1.6, align: 'right' },
          ],
          rows,
        },
      ],
      notes: [r.note, 'Summarizes book categories by your mapping. It does not determine deductibility and is not tax advice.'],
    },
  };
}

// ---------------------------------------------------------------------------
// Transactions (every matching line)
// ---------------------------------------------------------------------------
export async function transactionsPdf(
  s: ServiceContext,
  params: { from: string; to: string; accountId?: string; contactId?: string; sourceType?: string; q?: string },
  opts: ReportPdfOptions = {},
): Promise<ReportPdf> {
  const r = await transactionsReport(s, { ...params, all: true });
  const cur = r.currency;
  const subtitle = [range(r.from, r.to), 'Accrual basis'];
  if (params.accountId) {
    const [a] = await s.tx
      .select({ code: schema.accounts.code, name: schema.accounts.name })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, s.ctx.companyId), eq(schema.accounts.id, params.accountId)));
    if (a) subtitle.push(`Account: ${a.code} ${a.name}`);
  }
  if (params.contactId) {
    const [c] = await s.tx
      .select({ name: schema.contacts.name })
      .from(schema.contacts)
      .where(and(eq(schema.contacts.companyId, s.ctx.companyId), eq(schema.contacts.id, params.contactId)));
    if (c) subtitle.push(`Contact: ${c.name}`);
  }
  if (params.sourceType) subtitle.push(`Source: ${capitalize(params.sourceType)}`);
  if (params.q?.trim()) subtitle.push(`Memo contains "${params.q.trim()}"`);
  const rows: ReportPdfRow[] = r.rows.map((x) => ({
    kind: 'line',
    cells: [
      pdfDate(x.date),
      { text: x.entryNumber === null ? '—' : String(x.entryNumber), muted: true },
      { text: x.memo || '(no memo)', sub: x.lineMemo && x.lineMemo !== x.memo ? x.lineMemo : undefined },
      `${x.accountCode} ${x.accountName}`,
      { text: x.contactName ?? '', muted: true },
      { text: capitalize(x.sourceType), muted: true },
      x.debit !== '0.00' ? pdfMoney(x.debit, cur) : '',
      x.credit !== '0.00' ? pdfMoney(x.credit, cur) : '',
    ],
  }));
  if (rows.length === 0) rows.push({ kind: 'empty', text: 'No transactions match.' });
  rows.push({ kind: 'total', cells: [{ text: `Total · ${r.lineCount} ${r.lineCount === 1 ? 'line' : 'lines'}`, span: 6 }, pdfMoney(r.totalDebit, cur), pdfMoney(r.totalCredit, cur)] });
  return {
    fileName: `transactions-${r.from}-${r.to}.pdf`,
    document: {
      ...base(s, 'All activity', subtitle, opts, 'landscape'),
      tables: [
        {
          columns: [
            { header: 'Date', weight: 1.1 },
            { header: '#', weight: 0.55 },
            { header: 'Memo', weight: 3.6 },
            { header: 'Account', weight: 2.4 },
            { header: 'Contact', weight: 1.7 },
            { header: 'Source', weight: 1.4 },
            { header: 'Debit', weight: 1.25, align: 'right' },
            { header: 'Credit', weight: 1.25, align: 'right' },
          ],
          rows,
        },
      ],
      notes: [r.note],
    },
  };
}

// ---------------------------------------------------------------------------
// Outstanding invoices (aging)
// ---------------------------------------------------------------------------
export const AGING_BUCKET_LABELS = { current: 'Current', d1_30: '1–30 days', d31_60: '31–60 days', d61_90: '61–90 days', d90plus: '90+ days' } as const;
export type AgingBucketKey = keyof typeof AGING_BUCKET_LABELS;

export async function outstandingInvoicesPdf(
  s: ServiceContext,
  params: { asOf?: string; bucket?: AgingBucketKey; group?: 'invoice' | 'customer' },
  opts: ReportPdfOptions = {},
): Promise<ReportPdf> {
  const r = await outstandingInvoices(s, { asOf: params.asOf });
  const cur = r.currency;
  const items = r.items.filter((i) => !params.bucket || i.bucket === params.bucket);
  type Item = (typeof items)[number];
  const sum = (xs: Item[], k: 'total' | 'balanceDue') => Money.sum(xs.map((i) => Money.of(i[k], cur)), cur).toString();
  const invoiceRow = (i: Item): ReportPdfRow => {
    const overdue = i.daysOverdue > 0;
    return {
      kind: 'line',
      cells: [
        i.number,
        i.contactName,
        { text: pdfDate(i.issueDate), muted: true },
        { text: pdfDate(i.dueDate), tone: overdue ? 'danger' : undefined },
        { text: pdfMoney(i.total, cur), muted: true },
        { text: pdfMoney(i.balanceDue, cur), bold: overdue, tone: overdue ? 'danger' : undefined },
        overdue ? { text: `${i.daysOverdue}d`, tone: 'danger' } : { text: '—', muted: true },
      ],
    };
  };
  const rows: ReportPdfRow[] = [];
  if (items.length === 0) rows.push({ kind: 'empty', text: params.bucket ? 'No open invoice falls in this aging bucket.' : 'Nothing outstanding.' });
  if (params.group === 'customer') {
    const groups = new Map<string, { name: string; items: Item[] }>();
    for (const i of items) {
      const g = groups.get(i.contactId) ?? { name: i.contactName, items: [] };
      g.items.push(i);
      groups.set(i.contactId, g);
    }
    for (const g of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ kind: 'section', label: g.name });
      for (const i of g.items) rows.push(invoiceRow(i));
      rows.push({ kind: 'subtotal', cells: [{ text: `${g.name} subtotal`, span: 4 }, pdfMoney(sum(g.items, 'total'), cur), pdfMoney(sum(g.items, 'balanceDue'), cur), ''] });
    }
  } else {
    for (const i of items) rows.push(invoiceRow(i));
  }
  const shownTotal = params.bucket ? r.aging[params.bucket] : r.total;
  rows.push({ kind: 'total', cells: [{ text: 'Total', span: 4 }, pdfMoney(sum(items, 'total'), cur), pdfMoney(shownTotal, cur), ''] });
  const subtitle = [`As of ${pdfDate(r.asOf)}`];
  if (params.bucket) subtitle.push(`${AGING_BUCKET_LABELS[params.bucket]} only`);
  if (params.group === 'customer') subtitle.push('By customer');
  const overdue = items.filter((i) => i.daysOverdue > 0).length;
  if (overdue > 0) subtitle.push(`${overdue} overdue`);
  const countIn = (b: AgingBucketKey) => r.items.filter((i) => i.bucket === b).length;
  const plural = (n: number) => `${n} ${n === 1 ? 'invoice' : 'invoices'}`;
  return {
    fileName: `outstanding-invoices-${r.asOf}.pdf`,
    document: {
      ...base(s, 'Outstanding invoices', subtitle, opts),
      summary: [
        { label: 'Total outstanding', value: pdfMoney(r.total, cur), hint: plural(r.items.length) },
        ...(Object.keys(AGING_BUCKET_LABELS) as AgingBucketKey[]).map((b) => ({
          label: AGING_BUCKET_LABELS[b],
          value: pdfMoney(r.aging[b], cur),
          hint: plural(countIn(b)),
          tone: b !== 'current' && !isZero(r.aging[b]) ? ('danger' as const) : undefined,
        })),
      ],
      tables: [
        {
          columns: [
            { header: 'Invoice', weight: 1.2 },
            { header: 'Customer', weight: 2.6 },
            { header: 'Issued', weight: 1.2 },
            { header: 'Due', weight: 1.2 },
            { header: 'Total', weight: 1.4, align: 'right' },
            { header: 'Balance due', weight: 1.4, align: 'right' },
            { header: 'Days overdue', weight: 1, align: 'right' },
          ],
          rows,
        },
      ],
      notes: [r.note],
    },
  };
}
