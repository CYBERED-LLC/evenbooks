import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManualJournal, generalLedger, profitAndLoss, profitAndLossCsvRows, PROFIT_AND_LOSS_CSV_HEADERS, transactionsReport } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;

const line = (code: string, side: 'debit' | 'credit', amount: string, memo?: string) => ({ accountId: acct.get(code)!, [side]: amount, memo: memo ?? null });

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  const post = (date: string, memo: string, lines: ReturnType<typeof line>[]) =>
    w.run(w.ctxA, (s) => createManualJournal(s, { date, memo, cashTreatment: 'include', post: true, lines }));
  await post('2026-02-01', 'Owner funds the business', [line('1000', 'debit', '1000'), line('3000', 'credit', '1000')]);
  // Five sales and three expenses in March; one line memo is searchable.
  for (let i = 1; i <= 5; i++) await post(`2026-03-0${i}`, `Consulting sale ${i}`, [line('1000', 'debit', '100.10'), line('4100', 'credit', '100.10')]);
  await post('2026-03-10', 'Printer paper', [line('5110', 'debit', '25.00', 'Staples 100% recycled'), line('1000', 'credit', '25.00')]);
  await post('2026-03-11', 'Printer ink', [line('5110', 'debit', '40.00'), line('1000', 'credit', '40.00')]);
  await post('2026-03-12', 'Coffee_roast', [line('5110', 'debit', '12.50'), line('1000', 'credit', '12.50')]);
});
afterAll(async () => {
  await w.destroy();
});

describe('profit and loss CSV', () => {
  it('emits every line, totals and net income in screen order', async () => {
    const r = await w.run(w.ctxA, (s) => profitAndLoss(s, { from: '2026-03-01', to: '2026-03-31', basis: 'accrual' }));
    const rows = profitAndLossCsvRows(r);
    expect(PROFIT_AND_LOSS_CSV_HEADERS).toEqual(['Section', 'Code', 'Account', 'Amount']);
    const income = r.income.find((l) => l.code === '4100')!;
    expect(rows[0]).toEqual(['Income', '4100', income.name, '500.50']);
    expect(rows).toContainEqual(['Income', '', 'Total income', '500.50']);
    expect(rows).toContainEqual(['Expenses', '', 'Total expenses', '77.50']);
    expect(rows[rows.length - 1]).toEqual(['Net income', '', 'Net income', '423.00']);
    // Section order: income block, then expense block, then net income.
    const sections = rows.map((x) => x[0]);
    expect(sections.lastIndexOf('Income')).toBeLessThan(sections.indexOf('Expenses'));
  });

  it('adds sales tax collected on the cash basis only', async () => {
    const cash = await w.run(w.ctxA, (s) => profitAndLoss(s, { from: '2026-03-01', to: '2026-03-31', basis: 'cash' }));
    const rows = profitAndLossCsvRows(cash);
    expect(rows[rows.length - 1]).toEqual(['Not income', '', 'Sales tax collected', cash.salesTaxCollected]);
    const accrual = await w.run(w.ctxA, (s) => profitAndLoss(s, { from: '2026-03-01', to: '2026-03-31', basis: 'accrual' }));
    expect(profitAndLossCsvRows(accrual).some((x) => x[0] === 'Not income')).toBe(false);
  });
});

describe('transactions report', () => {
  it('totals every matching line across pages and carries the account id', async () => {
    const page1 = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', limit: 3 }));
    expect(page1.rows).toHaveLength(3);
    expect(page1.nextCursor).toBe('3');
    expect(page1.lineCount).toBe(16);
    expect(page1.totalDebit).toBe('578.00');
    expect(page1.totalCredit).toBe('578.00');
    expect(page1.rows[0]!.accountId).toBe(acct.get('1000'));
    const all = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', all: true }));
    expect(all.rows).toHaveLength(16);
    expect(all.nextCursor).toBeNull();
    expect(all.totalDebit).toBe(page1.totalDebit);
  });

  it('filters totals with the account filter', async () => {
    const r = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', accountId: acct.get('5110')! }));
    expect(r.lineCount).toBe(3);
    expect(r.totalDebit).toBe('77.50');
    expect(r.totalCredit).toBe('0.00');
  });

  it('searches entry and line memos case-insensitively, treating wildcards literally', async () => {
    const printer = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', q: 'PRINTER' }));
    expect(printer.lineCount).toBe(4);
    expect(printer.rows.every((r) => r.memo.startsWith('Printer'))).toBe(true);
    expect(printer.totalDebit).toBe('65.00');
    const lineMemo = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', q: 'staples' }));
    expect(lineMemo.lineCount).toBe(1);
    expect(lineMemo.rows[0]!.lineMemo).toBe('Staples 100% recycled');
    const percent = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', q: '100%' }));
    expect(percent.lineCount).toBe(1);
    const underscore = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', q: 'e_' }));
    expect(underscore.lineCount).toBe(2);
    expect(underscore.rows[0]!.memo).toBe('Coffee_roast');
    const none = await w.run(w.ctxA, (s) => transactionsReport(s, { from: '2026-03-01', to: '2026-03-31', q: 'nothing like this' }));
    expect(none.lineCount).toBe(0);
    expect(none.totalDebit).toBe('0.00');
  });
});

describe('general ledger', () => {
  it('pages lines but reports opening, closing and period totals for the whole range', async () => {
    const accountId = acct.get('1000')!;
    const p1 = await w.run(w.ctxA, (s) => generalLedger(s, { accountId, from: '2026-03-01', to: '2026-03-31', limit: 2 }));
    expect(p1.opening).toBe('1000.00');
    expect(p1.lines).toHaveLength(2);
    expect(p1.nextCursor).toBe('2');
    expect(p1.totalDebit).toBe('500.50');
    expect(p1.totalCredit).toBe('77.50');
    expect(p1.closing).toBe('1423.00');
    const p2 = await w.run(w.ctxA, (s) => generalLedger(s, { accountId, from: '2026-03-01', to: '2026-03-31', limit: 2, cursor: p1.nextCursor }));
    expect(p2.lines[0]!.running).toBe('1300.30');
    expect(p2.totalDebit).toBe(p1.totalDebit);
    expect(p2.closing).toBe(p1.closing);
  });

  it('returns every line with all: true', async () => {
    const accountId = acct.get('1000')!;
    const r = await w.run(w.ctxA, (s) => generalLedger(s, { accountId, from: '2026-03-01', to: '2026-03-31', limit: 2, all: true }));
    expect(r.lines).toHaveLength(8);
    expect(r.nextCursor).toBeNull();
    expect(r.lines[r.lines.length - 1]!.running).toBe(r.closing);
  });
});
