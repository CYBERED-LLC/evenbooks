import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManualJournal, trialBalance, updateAccount } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let accounts: Map<string, string>;

beforeAll(async () => {
  w = await createWorld();
  accounts = await w.accountsByCode(w.ctxA);
  const entry = (date: string, debit: string, credit: string, amount: string, post = true) => w.run(w.ctxA, (s) => createManualJournal(s, {
    date, memo: 'Trial balance fixture', cashTreatment: 'exclude', post,
    lines: [
      { accountId: accounts.get(debit)!, debit: amount, credit: '0' },
      { accountId: accounts.get(credit)!, debit: '0', credit: amount },
    ],
  }));
  await entry('2025-12-31', '1000', '3000', '100');
  await entry('2026-01-10', '5110', '1000', '40');
  await entry('2026-01-20', '1000', '5110', '10');
  await entry('2026-01-25', '5110', '1600', '5');
  await entry('2026-01-28', '1000', '5110', '50');
  await entry('2026-02-01', '1000', '4100', '200');
  await entry('2026-01-15', '1000', '4100', '7', false);
  await w.run(w.ctxA, (s) => updateAccount(s, accounts.get('1600')!, { version: 1, isActive: false }));
});
afterAll(async () => { await w.destroy(); });

describe('trial balance as of a date', () => {
  it('includes earlier years and nets postings, rather than showing period activity', async () => {
    const r = await w.run(w.ctxA, (s) => trialBalance(s, { asOf: '2026-01-20' }));
    expect(r.asOf).toBe('2026-01-20');
    expect(r.rows).toEqual([
      expect.objectContaining({ code: '1000', firstEntryDate: '2025-12-31', debit: '70.00', credit: '0.00' }),
      expect.objectContaining({ code: '3000', debit: '0.00', credit: '100.00' }),
      expect.objectContaining({ code: '5110', debit: '30.00', credit: '0.00' }),
    ]);
    expect(r.totalDebit).toBe('100.00');
    expect(r.totalCredit).toBe('100.00');
  });

  it('shows credit balances on assets and expenses, includes archived accounts, and excludes drafts and future entries', async () => {
    const r = await w.run(w.ctxA, (s) => trialBalance(s, { asOf: '2026-01-31' }));
    expect(r.rows).toEqual([
      expect.objectContaining({ code: '1000', debit: '120.00', credit: '0.00' }),
      expect.objectContaining({ code: '1600', debit: '0.00', credit: '5.00' }),
      expect.objectContaining({ code: '3000', debit: '0.00', credit: '100.00' }),
      expect.objectContaining({ code: '5110', debit: '0.00', credit: '15.00' }),
    ]);
    expect(r.totalDebit).toBe('120.00');
    expect(r.totalCredit).toBe('120.00');
    expect(r.rows.some((a) => a.code === '4100')).toBe(false);
  });

  it('returns zero totals before the first posting and respects the selected company', async () => {
    for (const ctx of [w.ctxA, w.ctxB]) {
      const r = await w.run(ctx, (s) => trialBalance(s, { asOf: '2025-12-30' }));
      expect(r.rows).toEqual([]);
      expect(r.totalDebit).toBe('0.00');
      expect(r.totalCredit).toBe('0.00');
    }
    expect((await w.run(w.ctxB, (s) => trialBalance(s, { asOf: '2026-01-31' }))).rows).toEqual([]);
  });
});
