import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { todayInTimeZone } from '@evenbooks/domain';
import {
  createAccount,
  createBankAccount,
  createManualBankTransaction,
  createManualJournal,
  excludeTransaction,
  listMappings,
  pendingReviewSummary,
  scheduleCSummary,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

// What reports warn about: bank lines nobody has reviewed yet, and money still
// sitting in the Uncategorized accounts on Schedule C.
let w: TestWorld;
let acct: Map<string, string>;
let checkingId: string;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  checkingId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! }))).id;
  const txn = (date: string, amount: string, description: string) => w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId: checkingId, date, amount, description }));
  await txn('2026-05-02', '1200.00', 'Client deposit');
  await txn('2026-05-10', '-80.25', 'Hardware store');
  await txn('2026-05-31', '-19.75', 'Coffee');
  await txn('2026-06-01', '-40.00', 'Next month');
  const excluded = await txn('2026-05-15', '-500.00', 'Duplicate line');
  await w.run(w.ctxA, (s) => excludeTransaction(s, excluded.id, { version: excluded.version, reason: 'Duplicate' }));
  // Beta has its own unreviewed line in May; it never shows up for Alpha.
  const betaAcct = await w.accountsByCode(w.ctxB);
  const betaBank = await w.run(w.ctxB, (s) => createBankAccount(s, { name: 'Beta checking', kind: 'bank', ledgerAccountId: betaAcct.get('1000')! }));
  await w.run(w.ctxB, (s) => createManualBankTransaction(s, { bankAccountId: betaBank.id, date: '2026-05-05', amount: '-9.99', description: 'Beta' }));
});
afterAll(async () => {
  await w.destroy();
});

describe('pending review summary', () => {
  it('counts unreviewed lines in a range with money in and out', async () => {
    const r = await w.run(w.ctxA, (s) => pendingReviewSummary(s, { from: '2026-05-01', to: '2026-05-31' }));
    expect(r).toMatchObject({ from: '2026-05-01', to: '2026-05-31', count: 3, moneyIn: '1200.00', moneyOut: '100.00', currency: 'USD' });
  });

  it('counts everything on or before the date for as-of reports', async () => {
    const r = await w.run(w.ctxA, (s) => pendingReviewSummary(s, { to: '2026-06-30' }));
    expect(r.from).toBeNull();
    expect(r.count).toBe(4);
    expect(r.moneyOut).toBe('140.00');
  });

  it('is zero for a range with nothing waiting', async () => {
    const r = await w.run(w.ctxA, (s) => pendingReviewSummary(s, { from: '2026-01-01', to: '2026-04-30' }));
    expect(r).toMatchObject({ count: 0, moneyIn: '0.00', moneyOut: '0.00' });
  });
});

describe('Schedule C uncategorized money', () => {
  it('calls out the Uncategorized accounts with the line they land on', async () => {
    await w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date: '2026-07-01',
        memo: 'Unknown charge',
        cashTreatment: 'include',
        post: true,
        lines: [
          { accountId: acct.get('5990')!, debit: '42.00' },
          { accountId: acct.get('1000')!, credit: '42.00' },
        ],
      }),
    );
    const r = await w.run(w.ctxA, (s) => scheduleCSummary(s, { taxYear: 2026, basis: 'cash' }));
    expect(r.uncategorized).toEqual([expect.objectContaining({ accountId: acct.get('5990'), type: 'expense', amount: '42.00', lineCode: '27b', lineLabel: 'Other expenses' })]);
    // Still counted on line 27b: the warning explains it, it doesn't move it.
    expect(r.lines.find((l) => l.code === '27b')!.amount).toBe('42.00');
  });
});

describe('new account with a tax-form line', () => {
  it('maps the account for the current tax year', async () => {
    const year = Number(todayInTimeZone('America/New_York').slice(0, 4));
    const a = await w.run(w.ctxA, (s) => createAccount(s, { code: '5555', name: 'Postage', type: 'expense', scheduleCLine: '18' }));
    const m = await w.run(w.ctxA, (s) => listMappings(s, year));
    expect(m.accounts.find((x) => x.id === a.id)?.lineCode).toBe('18');
  });

  it('rejects an unknown line and creates nothing', async () => {
    await expect(w.run(w.ctxA, (s) => createAccount(s, { code: '5556', name: 'Bad line', type: 'expense', scheduleCLine: '99' }))).rejects.toThrow(/no Schedule C line/);
    const codes = await w.accountsByCode(w.ctxA);
    expect(codes.has('5556')).toBe(false);
  });

  it('ignores the line for balance-sheet accounts', async () => {
    const year = Number(todayInTimeZone('America/New_York').slice(0, 4));
    const a = await w.run(w.ctxA, (s) => createAccount(s, { code: '1700', name: 'Deposits paid', type: 'asset', scheduleCLine: '18' }));
    const m = await w.run(w.ctxA, (s) => listMappings(s, year));
    expect(m.accounts.some((x) => x.id === a.id)).toBe(false);
  });
});
