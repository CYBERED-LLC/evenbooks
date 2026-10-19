import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, todayInTimeZone, isDebitNormal, type AccountType } from '@evenbooks/domain';
import type { ServiceContext } from './context';
import { ServiceError, plainDate } from './errors';
import type { Basis, ReportLine } from './reports';
import { profitAndLoss } from './reports';

/**
 * Remaining reports. Balance sheet, trial balance and general ledger are
 * accrual-only (they read posted journal lines). The category report and the
 * Schedule C summary reuse the P&L engine so both bases share one definition.
 * Every report states its basis in `note`, uses inclusive dates and stable ordering.
 */

export interface BalanceSheet {
  asOf: string;
  currency: string;
  assets: ReportLine[];
  liabilities: ReportLine[];
  equity: ReportLine[];
  /** Net income since the fiscal year start (closed into equity for presentation only). */
  currentYearEarnings: string;
  retainedEarningsPriorYears: string;
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  /** assets − (liabilities + equity); always "0.00" for a consistent ledger */
  difference: string;
  note: string;
}

function fiscalYearStart(asOf: string, startMonth: number): string {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  const fyYear = m >= startMonth ? y : y - 1;
  return `${fyYear}-${String(startMonth).padStart(2, '0')}-01`;
}

export async function balanceSheet(s: ServiceContext, params: { asOf: string }): Promise<BalanceSheet> {
  const cur = s.company.baseCurrency;
  const asOf = params.asOf;
  const rows = await s.tx.execute<{ account_id: string; code: string; name: string; type: AccountType; balance: string }>(sql`
    select a.id as account_id, a.code, a.name, a.type::text as type,
           -- Only lines whose entry is posted and dated on or before asOf: the left join keeps other
           -- lines as rows with e.id null, so the sums must skip them explicitly.
           case when a.type in ('asset','expense') then coalesce(sum(case when e.id is not null then l.debit - l.credit end), 0)
                else coalesce(sum(case when e.id is not null then l.credit - l.debit end), 0) end::text as balance
      from accounts a
      left join journal_lines l on l.account_id = a.id
      left join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.date <= ${asOf}::date
     where a.company_id = ${s.ctx.companyId} and a.type in ('asset','liability','equity')
     group by a.id
     having coalesce(sum(case when e.id is not null then 1 else 0 end), 0) > 0
     order by a.code`);
  const line = (r: (typeof rows.rows)[number]): ReportLine => ({ accountId: r.account_id, code: r.code, name: r.name, amount: Money.round(r.balance, cur).toString() });
  const assets = rows.rows.filter((r) => r.type === 'asset').map(line).filter((l) => !Money.of(l.amount, cur).isZero());
  const liabilities = rows.rows.filter((r) => r.type === 'liability').map(line).filter((l) => !Money.of(l.amount, cur).isZero());
  const equityRows = rows.rows.filter((r) => r.type === 'equity').map(line).filter((l) => !Money.of(l.amount, cur).isZero());
  // P&L to date split into prior years (retained) and current fiscal year
  const fyStart = fiscalYearStart(asOf, s.company.fiscalYearStartMonth);
  const prior = await profitAndLoss(s, { from: '1900-01-01', to: fyStart < '1900-01-02' ? '1900-01-01' : addDaysStr(fyStart, -1), basis: 'accrual' });
  const current = await profitAndLoss(s, { from: fyStart, to: asOf, basis: 'accrual' });
  const totalAssets = Money.sum(assets.map((l) => Money.of(l.amount, cur)), cur);
  const totalLiabilities = Money.sum(liabilities.map((l) => Money.of(l.amount, cur)), cur);
  const equityBase = Money.sum(equityRows.map((l) => Money.of(l.amount, cur)), cur);
  const totalEquity = equityBase.add(Money.of(prior.netIncome, cur)).add(Money.of(current.netIncome, cur));
  return {
    asOf,
    currency: cur,
    assets,
    liabilities,
    equity: equityRows,
    currentYearEarnings: current.netIncome,
    retainedEarningsPriorYears: prior.netIncome,
    totalAssets: totalAssets.toString(),
    totalLiabilities: totalLiabilities.toString(),
    totalEquity: totalEquity.toString(),
    difference: totalAssets.subtract(totalLiabilities).subtract(totalEquity).toString(),
    note: `What the business has, what it owes and what is left for you on ${plainDate(asOf)}. Invoices and bills count when issued (accrual basis). Profit since ${plainDate(fyStart)} shows as profit this year so far.`,
  };
}

function addDaysStr(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface TrialBalance {
  asOf: string;
  currency: string;
  rows: { accountId: string; code: string; name: string; type: AccountType; firstEntryDate: string; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
  note: string;
}

export async function trialBalance(s: ServiceContext, params: { asOf: string }): Promise<TrialBalance> {
  const cur = s.company.baseCurrency;
  const rows = await s.tx.execute<{ account_id: string; code: string; name: string; type: AccountType; first_entry_date: string; balance: string }>(sql`
    select a.id as account_id, a.code, a.name, a.type::text as type,
           min(e.date)::text as first_entry_date,
           coalesce(sum(l.debit - l.credit), 0)::text as balance
      from accounts a
      join journal_lines l on l.account_id = a.id
      join journal_entries e on e.id = l.entry_id and e.status = 'posted' and e.date <= ${params.asOf}::date
     where a.company_id = ${s.ctx.companyId}
     group by a.id
     order by a.code`);
  let totalDebit = Money.zero(cur);
  let totalCredit = Money.zero(cur);
  const out = rows.rows.map((r) => {
    const balance = Money.round(r.balance, cur); // debit-positive, regardless of account type
    const debit = balance.isPositive() ? balance : Money.zero(cur);
    const credit = balance.isNegative() ? balance.negate() : Money.zero(cur);
    totalDebit = totalDebit.add(debit);
    totalCredit = totalCredit.add(credit);
    return { accountId: r.account_id, code: r.code, name: r.name, type: r.type, firstEntryDate: r.first_entry_date, debit: debit.toString(), credit: credit.toString() };
  });
  return { asOf: params.asOf, currency: cur, rows: out, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString(), note: `For your accountant: every account's balance on ${plainDate(params.asOf)}, in debit and credit columns (accrual basis).` };
}

export interface GeneralLedgerLine {
  entryId: string;
  entryNumber: number | null;
  date: string;
  memo: string;
  lineMemo: string | null;
  sourceType: string;
  sourceId: string | null;
  contactId: string | null;
  debit: string;
  credit: string;
  running: string;
}

export interface GeneralLedger {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  from: string;
  to: string;
  currency: string;
  opening: string;
  lines: GeneralLedgerLine[];
  closing: string;
  /** Period debit and credit totals over the whole range, not just this page. */
  totalDebit: string;
  totalCredit: string;
  nextCursor: string | null;
  note: string;
}

/** `all: true` returns every line in the range (CSV export); otherwise lines are paged. */
export async function generalLedger(s: ServiceContext, params: { accountId: string; from: string; to: string; limit?: number; cursor?: string | null; all?: boolean }): Promise<GeneralLedger> {
  const cur = s.company.baseCurrency;
  const [acct] = await s.tx.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, s.ctx.companyId), eq(schema.accounts.id, params.accountId)));
  if (!acct) throw new ServiceError('not_found', 'Account not found');
  const debitNormal = isDebitNormal(acct.type);
  const openingRow = await s.tx.execute<{ v: string }>(sql`
    select coalesce(sum(l.debit - l.credit), 0)::text as v from journal_lines l join journal_entries e on e.id = l.entry_id
     where l.account_id = ${params.accountId} and e.status = 'posted' and e.date < ${params.from}::date`);
  const openingDebit = Money.round(openingRow.rows[0]!.v, cur);
  const limit = Math.min(params.limit ?? 500, 2000);
  const rows = await s.tx.execute<{ entry_id: string; entry_number: string | null; date: string; memo: string; line_memo: string | null; source_type: string; source_id: string | null; contact_id: string | null; debit: string; credit: string; line_id: string }>(sql`
    select e.id as entry_id, e.entry_number::text as entry_number, e.date::text as date, e.memo, l.memo as line_memo, e.source_type::text as source_type, e.source_id, l.contact_id, l.debit::text, l.credit::text, l.id as line_id
      from journal_lines l join journal_entries e on e.id = l.entry_id
     where l.account_id = ${params.accountId} and e.status = 'posted' and e.date between ${params.from}::date and ${params.to}::date
     order by e.date, e.entry_number, l.line_no`);
  // running balance over the whole range (stable ordering), then page
  let running = openingDebit;
  const all: GeneralLedgerLine[] = rows.rows.map((r) => {
    running = running.add(Money.round(r.debit, cur)).subtract(Money.round(r.credit, cur));
    return {
      entryId: r.entry_id,
      entryNumber: r.entry_number ? Number(r.entry_number) : null,
      date: r.date,
      memo: r.memo,
      lineMemo: r.line_memo,
      sourceType: r.source_type,
      sourceId: r.source_id,
      contactId: r.contact_id,
      debit: Money.round(r.debit, cur).toString(),
      credit: Money.round(r.credit, cur).toString(),
      running: (debitNormal ? running : running.negate()).toString(),
    };
  });
  const offset = params.all ? 0 : params.cursor ? Number(params.cursor) || 0 : 0;
  const page = params.all ? all : all.slice(offset, offset + limit);
  let totalDebit = Money.zero(cur);
  let totalCredit = Money.zero(cur);
  for (const l of all) {
    totalDebit = totalDebit.add(Money.round(l.debit, cur));
    totalCredit = totalCredit.add(Money.round(l.credit, cur));
  }
  return {
    accountId: acct.id,
    code: acct.code,
    name: acct.name,
    type: acct.type,
    from: params.from,
    to: params.to,
    currency: cur,
    opening: (debitNormal ? openingDebit : openingDebit.negate()).toString(),
    lines: page,
    closing: (debitNormal ? running : running.negate()).toString(),
    totalDebit: totalDebit.toString(),
    totalCredit: totalCredit.toString(),
    nextCursor: !params.all && offset + limit < all.length ? String(offset + limit) : null,
    note: 'Every change to this account in date order, with the balance after each one. Invoices and bills count when issued (accrual basis).',
  };
}

export interface CategoryReport {
  basis: Basis;
  from: string;
  to: string;
  currency: string;
  groups: { type: 'income' | 'expense'; lines: (ReportLine & { count: number })[]; total: string }[];
  uncategorized: { income: string; expense: string };
  netIncome: string;
  note: string;
}

/** Income/expense by category with transaction counts; uncategorized accounts are surfaced, never hidden. */
export async function categoryReport(s: ServiceContext, params: { from: string; to: string; basis: Basis }): Promise<CategoryReport> {
  const cur = s.company.baseCurrency;
  const pnl = await profitAndLoss(s, params);
  const counts =
    params.basis === 'accrual'
      ? await s.tx.execute<{ account_id: string; n: string }>(sql`
          select l.account_id, count(distinct e.id)::text as n from journal_lines l join journal_entries e on e.id = l.entry_id
           where l.company_id = ${s.ctx.companyId} and e.status = 'posted' and e.date between ${params.from}::date and ${params.to}::date group by l.account_id`)
      : await s.tx.execute<{ account_id: string; n: string }>(sql`
          select account_id, count(distinct event_id)::text as n from cash_recognitions
           where company_id = ${s.ctx.companyId} and date between ${params.from}::date and ${params.to}::date group by account_id`);
  const countBy = new Map(counts.rows.map((c) => [c.account_id, Number(c.n)]));
  const uncategorizedCodes = await s.tx.select({ id: schema.accounts.id, role: schema.accounts.role }).from(schema.accounts).where(and(eq(schema.accounts.companyId, s.ctx.companyId), sql`${schema.accounts.role} in ('uncategorized_income','uncategorized_expense')`));
  const uncInc = uncategorizedCodes.find((a) => a.role === 'uncategorized_income');
  const uncExp = uncategorizedCodes.find((a) => a.role === 'uncategorized_expense');
  const withCounts = (lines: ReportLine[]) => lines.map((l) => ({ ...l, count: countBy.get(l.accountId) ?? 0 }));
  return {
    basis: params.basis,
    from: params.from,
    to: params.to,
    currency: cur,
    groups: [
      { type: 'income', lines: withCounts(pnl.income), total: pnl.totalIncome },
      { type: 'expense', lines: withCounts(pnl.expenses), total: pnl.totalExpenses },
    ],
    uncategorized: {
      income: pnl.income.find((l) => l.accountId === uncInc?.id)?.amount ?? '0.00',
      expense: pnl.expenses.find((l) => l.accountId === uncExp?.id)?.amount ?? '0.00',
    },
    netIncome: pnl.netIncome,
    note: pnl.note,
  };
}

// ---------------------------------------------------------------------------
// Schedule C summary (2025 layout)
// ---------------------------------------------------------------------------
export const SCHEDULE_C_LINES: { code: string; label: string; part: 'income' | 'expense' | 'other'; note?: string }[] = [
  { code: '1', label: 'Gross receipts or sales', part: 'income' },
  { code: '2', label: 'Returns and allowances', part: 'income' },
  { code: '6', label: 'Other income', part: 'income' },
  { code: '8', label: 'Advertising', part: 'expense' },
  { code: '9', label: 'Car and truck expenses', part: 'expense' },
  { code: '10', label: 'Commissions and fees', part: 'expense' },
  { code: '11', label: 'Contract labor', part: 'expense' },
  { code: '12', label: 'Depletion', part: 'expense' },
  { code: '13', label: 'Depreciation and section 179', part: 'expense' },
  { code: '14', label: 'Employee benefit programs', part: 'expense' },
  { code: '15', label: 'Insurance (other than health)', part: 'expense' },
  { code: '16a', label: 'Interest: mortgage', part: 'expense' },
  { code: '16b', label: 'Interest: other', part: 'expense' },
  { code: '17', label: 'Legal and professional services', part: 'expense' },
  { code: '18', label: 'Office expense', part: 'expense' },
  { code: '19', label: 'Pension and profit-sharing plans', part: 'expense' },
  { code: '20a', label: 'Rent or lease: vehicles, machinery, equipment', part: 'expense' },
  { code: '20b', label: 'Rent or lease: other business property', part: 'expense' },
  { code: '21', label: 'Repairs and maintenance', part: 'expense' },
  { code: '22', label: 'Supplies', part: 'expense' },
  { code: '23', label: 'Taxes and licenses', part: 'expense' },
  { code: '24a', label: 'Travel', part: 'expense' },
  { code: '24b', label: 'Deductible meals', part: 'expense', note: 'Book amount shown at 100%; the 50% limitation (80% for DOT hours-of-service) applies on the return.' },
  { code: '25', label: 'Utilities', part: 'expense' },
  { code: '26', label: 'Wages', part: 'expense' },
  { code: '27a', label: 'Energy efficient commercial buildings deduction', part: 'expense' },
  { code: '27b', label: 'Other expenses', part: 'expense' },
  { code: 'excluded', label: 'Not on Schedule C (excluded by mapping)', part: 'other' },
];

export interface ScheduleCSummary {
  taxYear: number;
  basis: Basis;
  currency: string;
  lines: { code: string; label: string; part: string; amount: string; accounts: ReportLine[]; note?: string }[];
  unmapped: ReportLine[];
  /**
   * Money still in the built-in Uncategorized income/expense accounts, with the
   * line it currently lands on (by default 6 and 27b). Never dropped, but called
   * out: until it is categorized the line totals are only a guess.
   */
  uncategorized: (ReportLine & { type: 'income' | 'expense'; lineCode: string | null; lineLabel: string | null })[];
  grossReceipts: string;
  totalExpenses: string;
  tentativeProfit: string;
  note: string;
}

export async function scheduleCSummary(s: ServiceContext, params: { taxYear: number; basis: Basis }): Promise<ScheduleCSummary> {
  const cur = s.company.baseCurrency;
  const from = `${params.taxYear}-01-01`;
  const to = `${params.taxYear}-12-31`;
  const pnl = await profitAndLoss(s, { from, to, basis: params.basis });
  const mappings = await s.tx
    .select()
    .from(schema.taxFormMappings)
    .where(and(eq(schema.taxFormMappings.companyId, s.ctx.companyId), eq(schema.taxFormMappings.form, 'schedule_c'), eq(schema.taxFormMappings.taxYear, params.taxYear)));
  const lineFor = new Map(mappings.map((m) => [m.accountId, m.lineCode]));
  const byLine = new Map<string, ReportLine[]>();
  const unmapped: ReportLine[] = [];
  for (const l of [...pnl.income, ...pnl.expenses]) {
    const code = lineFor.get(l.accountId);
    if (!code) {
      unmapped.push(l);
      continue;
    }
    if (!byLine.has(code)) byLine.set(code, []);
    byLine.get(code)!.push(l);
  }
  const lines = SCHEDULE_C_LINES.map((def) => {
    const accounts = byLine.get(def.code) ?? [];
    return { code: def.code, label: def.label, part: def.part, amount: Money.sum(accounts.map((a) => Money.of(a.amount, cur)), cur).toString(), accounts, note: def.note };
  }).filter((l) => l.accounts.length > 0 || ['1', '2', '6'].includes(l.code));
  const uncategorizedRoles = await s.tx
    .select({ id: schema.accounts.id, role: schema.accounts.role })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, s.ctx.companyId), sql`${schema.accounts.role} in ('uncategorized_income','uncategorized_expense')`));
  const uncategorized: ScheduleCSummary['uncategorized'] = [];
  for (const a of uncategorizedRoles) {
    const type = a.role === 'uncategorized_income' ? 'income' : 'expense';
    const l = (type === 'income' ? pnl.income : pnl.expenses).find((x) => x.accountId === a.id);
    if (!l) continue;
    const code = lineFor.get(a.id) ?? null;
    uncategorized.push({ ...l, type, lineCode: code, lineLabel: SCHEDULE_C_LINES.find((d) => d.code === code)?.label ?? null });
  }
  const income = (code: string) => Money.of(lines.find((l) => l.code === code)?.amount ?? '0', cur);
  const grossReceipts = income('1').subtract(income('2')).add(income('6'));
  const totalExpenses = Money.sum(lines.filter((l) => l.part === 'expense').map((l) => Money.of(l.amount, cur)), cur);
  return {
    taxYear: params.taxYear,
    basis: params.basis,
    currency: cur,
    lines,
    unmapped,
    uncategorized,
    grossReceipts: grossReceipts.toString(),
    totalExpenses: totalExpenses.toString(),
    tentativeProfit: grossReceipts.subtract(totalExpenses).toString(),
    note: `${pnl.note} Categories without a ${params.taxYear} line are listed separately; choose one before you file.`,
  };
}

export async function listMappings(s: ServiceContext, taxYear: number) {
  const accounts = await s.tx
    .select({ id: schema.accounts.id, code: schema.accounts.code, name: schema.accounts.name, type: schema.accounts.type, isActive: schema.accounts.isActive })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, s.ctx.companyId), sql`${schema.accounts.type} in ('income','expense')`))
    .orderBy(asc(schema.accounts.code));
  const mappings = await s.tx.select().from(schema.taxFormMappings).where(and(eq(schema.taxFormMappings.companyId, s.ctx.companyId), eq(schema.taxFormMappings.form, 'schedule_c'), eq(schema.taxFormMappings.taxYear, taxYear)));
  const byAccount = new Map(mappings.map((m) => [m.accountId, m.lineCode]));
  return { taxYear, lines: SCHEDULE_C_LINES, accounts: accounts.map((a) => ({ ...a, lineCode: byAccount.get(a.id) ?? null })) };
}

export async function setMappings(s: ServiceContext, taxYear: number, entries: { accountId: string; lineCode: string | null }[]): Promise<void> {
  const valid = new Set(SCHEDULE_C_LINES.map((l) => l.code));
  for (const e of entries) {
    if (e.lineCode !== null && !valid.has(e.lineCode)) throw new ServiceError('validation', `There is no Schedule C line “${e.lineCode}”. Choose a line from the list.`);
    if (e.lineCode === null) {
      await s.tx.delete(schema.taxFormMappings).where(and(eq(schema.taxFormMappings.companyId, s.ctx.companyId), eq(schema.taxFormMappings.taxYear, taxYear), eq(schema.taxFormMappings.accountId, e.accountId)));
    } else {
      await s.tx
        .insert(schema.taxFormMappings)
        .values({ companyId: s.ctx.companyId, form: 'schedule_c', taxYear, accountId: e.accountId, lineCode: e.lineCode })
        .onConflictDoUpdate({ target: [schema.taxFormMappings.companyId, schema.taxFormMappings.form, schema.taxFormMappings.taxYear, schema.taxFormMappings.accountId], set: { lineCode: e.lineCode, updatedAt: new Date().toISOString() } });
    }
  }
}

/** Copy the previous year's mapping into a new tax year (only for accounts not yet mapped). */
export async function copyMappings(s: ServiceContext, fromYear: number, toYear: number): Promise<number> {
  const res = await s.tx.execute<{ n: string }>(sql`
    with ins as (
      insert into tax_form_mappings (company_id, form, tax_year, account_id, line_code)
      select company_id, form, ${toYear}, account_id, line_code from tax_form_mappings
       where company_id = ${s.ctx.companyId} and form = 'schedule_c' and tax_year = ${fromYear}
      on conflict do nothing returning 1)
    select count(*)::text as n from ins`);
  return Number(res.rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// Transactions by date range (all posted lines, drill-down source)
// ---------------------------------------------------------------------------
export interface TransactionsReportRow {
  entryId: string;
  entryNumber: number | null;
  date: string;
  memo: string;
  lineMemo: string | null;
  sourceType: string;
  sourceId: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  contactId: string | null;
  contactName: string | null;
  debit: string;
  credit: string;
}

export interface TransactionsReportParams {
  from: string;
  to: string;
  accountId?: string;
  contactId?: string;
  sourceType?: string;
  /** Case-insensitive search in the entry memo and the line memo. */
  q?: string;
  limit?: number;
  cursor?: string | null;
  /** Every matching line (CSV export); otherwise lines are paged. */
  all?: boolean;
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Posted ledger lines in a range. Totals and the line count cover every matching line, not just the page. */
export async function transactionsReport(s: ServiceContext, params: TransactionsReportParams) {
  const cur = s.company.baseCurrency;
  const limit = Math.min(params.limit ?? 200, 1000);
  const offset = params.all ? 0 : params.cursor ? Number(params.cursor) || 0 : 0;
  const q = params.q?.trim();
  const where = sql`l.company_id = ${s.ctx.companyId} and e.status = 'posted' and e.date between ${params.from}::date and ${params.to}::date
       ${params.accountId ? sql`and l.account_id = ${params.accountId}` : sql``}
       ${params.contactId ? sql`and l.contact_id = ${params.contactId}` : sql``}
       ${params.sourceType ? sql`and e.source_type = ${params.sourceType}::journal_source` : sql``}
       ${q ? sql`and (e.memo ilike ${likePattern(q)} or coalesce(l.memo, '') ilike ${likePattern(q)})` : sql``}`;
  const rows = await s.tx.execute<{ entry_id: string; entry_number: string | null; date: string; memo: string; line_memo: string | null; source_type: string; source_id: string | null; account_id: string; code: string; name: string; contact_id: string | null; contact: string | null; debit: string; credit: string }>(sql`
    select e.id as entry_id, e.entry_number::text as entry_number, e.date::text as date, e.memo, l.memo as line_memo, e.source_type::text as source_type, e.source_id,
           a.id as account_id, a.code, a.name, l.contact_id, c.name as contact, l.debit::text as debit, l.credit::text as credit
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
      join accounts a on a.id = l.account_id
      left join contacts c on c.id = l.contact_id
     where ${where}
     order by e.date, e.entry_number, l.line_no
     ${params.all ? sql`` : sql`limit ${limit + 1} offset ${offset}`}`);
  const totals = await s.tx.execute<{ debit: string; credit: string; n: string }>(sql`
    select coalesce(sum(l.debit), 0)::text as debit, coalesce(sum(l.credit), 0)::text as credit, count(*)::text as n
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where ${where}`);
  const t = totals.rows[0]!;
  const page = params.all ? rows.rows : rows.rows.slice(0, limit);
  return {
    from: params.from,
    to: params.to,
    currency: cur,
    rows: page.map(
      (r): TransactionsReportRow => ({
        entryId: r.entry_id,
        entryNumber: r.entry_number ? Number(r.entry_number) : null,
        date: r.date,
        memo: r.memo,
        lineMemo: r.line_memo,
        sourceType: r.source_type,
        sourceId: r.source_id,
        accountId: r.account_id,
        accountCode: r.code,
        accountName: r.name,
        contactId: r.contact_id,
        contactName: r.contact,
        debit: Money.round(r.debit, cur).toString(),
        credit: Money.round(r.credit, cur).toString(),
      }),
    ),
    /** Sums over every matching line in the range (all pages). */
    totalDebit: Money.round(t.debit, cur).toString(),
    totalCredit: Money.round(t.credit, cur).toString(),
    lineCount: Number(t.n),
    nextCursor: !params.all && rows.rows.length > limit ? String(offset + limit) : null,
    note: 'Every line recorded in your books in this period, in date order. Invoices and bills count when issued (accrual basis).',
  };
}

export async function outstandingInvoices(s: ServiceContext, params: { asOf?: string }) {
  const cur = s.company.baseCurrency;
  const asOf = params.asOf ?? todayInTimeZone(s.company.timeZone);
  const rows = await s.tx.execute<{ id: string; number: string; contact_id: string; contact: string; issue_date: string; due_date: string; total: string; balance: string }>(sql`
    select i.id, i.number, c.id as contact_id, c.name as contact, i.issue_date::text as issue_date, i.due_date::text as due_date, i.total::text, i.balance_due::text as balance
      from invoices i join contacts c on c.id = i.contact_id
     where i.company_id = ${s.ctx.companyId} and i.status = 'issued' and i.issue_date <= ${asOf}::date
     order by i.due_date, i.number`);
  const buckets = { current: Money.zero(cur), d1_30: Money.zero(cur), d31_60: Money.zero(cur), d61_90: Money.zero(cur), d90plus: Money.zero(cur) };
  const items = rows.rows.map((r) => {
    const bal = Money.round(r.balance, cur);
    const days = Math.floor((Date.parse(asOf) - Date.parse(r.due_date)) / 86_400_000);
    const bucket = days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90plus';
    buckets[bucket] = buckets[bucket].add(bal);
    return { id: r.id, number: r.number, contactId: r.contact_id, contactName: r.contact, issueDate: r.issue_date, dueDate: r.due_date, total: Money.round(r.total, cur).toString(), balanceDue: bal.toString(), daysOverdue: Math.max(0, days), bucket };
  });
  return {
    asOf,
    currency: cur,
    items,
    aging: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.toString()])) as Record<keyof typeof buckets, string>,
    total: Money.sum(items.map((i) => Money.of(i.balanceDue, cur)), cur).toString(),
    note: `Invoices still unpaid on ${plainDate(asOf)}, grouped by how many days past due they are.`,
  };
}
