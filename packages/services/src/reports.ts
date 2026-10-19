import { assertImportedCashReviewed } from './import-cash';
import { sql } from 'drizzle-orm';
import { Money } from '@evenbooks/domain';
import type { ServiceContext } from './context';

/**
 * Reports. Cash/accrual selection applies to the P&L family only; the balance
 * sheet, trial balance and general ledger are accrual-only. All report figures
 * come from posted entries (accrual) or the cash recognition layer (cash) —
 * never from bank feeds or drafts. Date ranges are inclusive.
 */
export type Basis = 'accrual' | 'cash';

export interface ReportLine {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

export interface ProfitAndLoss {
  basis: Basis;
  from: string;
  to: string;
  currency: string;
  income: ReportLine[];
  expenses: ReportLine[];
  totalIncome: string;
  totalExpenses: string;
  netIncome: string;
  /** Cash basis only: sales tax collected (a liability, shown for completeness, not income). */
  salesTaxCollected?: string;
  note: string;
}

export async function profitAndLoss(s: ServiceContext, params: { from: string; to: string; basis: Basis }): Promise<ProfitAndLoss> {
  const cur = s.company.baseCurrency;
  const { from, to, basis } = params;
  if (basis === 'cash') await assertImportedCashReviewed(s, from, to);
  let rows: { account_id: string; code: string; name: string; type: string; amount: string }[];
  let salesTax: string | undefined;
  if (basis === 'accrual') {
    const r = await s.tx.execute<{ account_id: string; code: string; name: string; type: string; amount: string }>(sql`
      select a.id as account_id, a.code, a.name, a.type::text as type,
             case when a.type = 'income' then coalesce(sum(l.credit - l.debit), 0) else coalesce(sum(l.debit - l.credit), 0) end::text as amount
        from accounts a
        join journal_lines l on l.account_id = a.id
        join journal_entries e on e.id = l.entry_id and e.status = 'posted'
       where a.company_id = ${s.ctx.companyId} and a.type in ('income', 'expense')
         and e.date between ${from}::date and ${to}::date
       group by a.id
       having sum(l.credit - l.debit) <> 0
       order by a.code`);
    rows = r.rows;
  } else {
    const r = await s.tx.execute<{ account_id: string; code: string; name: string; type: string; amount: string }>(sql`
      select a.id as account_id, a.code, a.name, a.type::text as type, coalesce(sum(c.amount), 0)::text as amount
        from cash_recognitions c
        join accounts a on a.id = c.account_id
       where c.company_id = ${s.ctx.companyId} and a.type in ('income', 'expense')
         and c.date between ${from}::date and ${to}::date
       group by a.id
       having sum(c.amount) <> 0
       order by a.code`);
    rows = r.rows;
    const t = await s.tx.execute<{ amount: string }>(sql`
      select coalesce(sum(amount), 0)::text as amount from cash_recognitions
       where company_id = ${s.ctx.companyId} and kind = 'tax' and date between ${from}::date and ${to}::date`);
    salesTax = Money.round(t.rows[0]!.amount, cur).toString();
  }
  const income = rows.filter((r) => r.type === 'income').map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, amount: Money.round(r.amount, cur).toString() }));
  const expenses = rows.filter((r) => r.type === 'expense').map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, amount: Money.round(r.amount, cur).toString() }));
  const totalIncome = Money.sum(income.map((l) => Money.of(l.amount, cur)), cur);
  const totalExpenses = Money.sum(expenses.map((l) => Money.of(l.amount, cur)), cur);
  return {
    basis,
    from,
    to,
    currency: cur,
    income,
    expenses,
    totalIncome: totalIncome.toString(),
    totalExpenses: totalExpenses.toString(),
    netIncome: totalIncome.subtract(totalExpenses).toString(),
    salesTaxCollected: salesTax,
    note: basisNote(basis),
  };
}

/** One plain sentence saying when the report counts money, shared by the P&L family. */
export function basisNote(basis: Basis): string {
  return basis === 'cash'
    ? 'Cash basis: income when customers paid you, expenses when you paid (card purchases count on the day you charged them).'
    : 'Accrual basis: income when you invoiced, expenses when you were billed, whether or not money has moved yet.';
}

export interface PendingReviewSummary {
  /** Null for an as-of report: everything on or before `to`. */
  from: string | null;
  to: string;
  currency: string;
  /** Bank transactions still in the bank inbox's "For review" tab. */
  count: number;
  /** Sum of the money-in lines (positive amounts). */
  moneyIn: string;
  /** Sum of the money-out lines, as a positive amount. */
  moneyOut: string;
}

/**
 * Bank transactions dated in the range that nobody has reviewed yet. Reports
 * read only what is recorded, so these are missing from every figure until
 * they are categorized, matched or excluded; screens warn with this count.
 */
export async function pendingReviewSummary(s: ServiceContext, params: { from?: string | null; to: string }): Promise<PendingReviewSummary> {
  const cur = s.company.baseCurrency;
  const from = params.from ?? null;
  const r = await s.tx.execute<{ n: number; money_in: string; money_out: string }>(sql`
    select count(*)::int as n,
           coalesce(sum(amount) filter (where amount > 0), 0)::text as money_in,
           coalesce(-sum(amount) filter (where amount < 0), 0)::text as money_out
      from bank_transactions
     where company_id = ${s.ctx.companyId} and status = 'unreviewed'
       and date <= ${params.to}::date
       ${from ? sql`and date >= ${from}::date` : sql``}`);
  const row = r.rows[0]!;
  return { from, to: params.to, currency: cur, count: Number(row.n), moneyIn: Money.round(row.money_in, cur).toString(), moneyOut: Money.round(row.money_out, cur).toString() };
}

/**
 * CSV rows for a P&L (header `Section,Code,Account,Amount`), in screen order:
 * income lines, total income, expense lines, total expenses, net income, and on
 * the cash basis the sales tax collected (not income).
 */
export const PROFIT_AND_LOSS_CSV_HEADERS = ['Section', 'Code', 'Account', 'Amount'];

export function profitAndLossCsvRows(r: ProfitAndLoss): string[][] {
  const rows: string[][] = [];
  for (const l of r.income) rows.push(['Income', l.code, l.name, l.amount]);
  rows.push(['Income', '', 'Total income', r.totalIncome]);
  for (const l of r.expenses) rows.push(['Expenses', l.code, l.name, l.amount]);
  rows.push(['Expenses', '', 'Total expenses', r.totalExpenses]);
  rows.push(['Net income', '', 'Net income', r.netIncome]);
  if (r.basis === 'cash' && r.salesTaxCollected !== undefined) rows.push(['Not income', '', 'Sales tax collected', r.salesTaxCollected]);
  return rows;
}
