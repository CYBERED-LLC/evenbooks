import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { balanceSheet, createManualJournal } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  const entry = (date: string, amount: string, post: boolean, key: string) =>
    w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date,
        memo: `owner contribution ${key}`,
        cashTreatment: 'include',
        post,
        idempotencyKey: `bs-asof-${key}-xxxxxxxx`,
        lines: [
          { accountId: acct.get('1000')!, debit: amount },
          { accountId: acct.get('3000')!, credit: amount },
        ],
      }),
    );
  await entry('2026-01-15', '100.00', true, 'jan');
  await entry('2026-06-15', '40.00', true, 'jun'); // after the as-of date below
  await entry('2026-02-01', '7.00', false, 'draft'); // never posted
});
afterAll(async () => {
  await w.destroy();
});

describe('balance sheet as of a date', () => {
  it('counts only posted entries dated on or before the as-of date', async () => {
    const march = await w.run(w.ctxA, (s) => balanceSheet(s, { asOf: '2026-03-31' }));
    expect(march.assets.find((l) => l.code === '1000')?.amount).toBe('100.00');
    expect(march.totalAssets).toBe('100.00');
    expect(march.difference).toBe('0.00');

    const july = await w.run(w.ctxA, (s) => balanceSheet(s, { asOf: '2026-07-31' }));
    expect(july.assets.find((l) => l.code === '1000')?.amount).toBe('140.00');

    const before = await w.run(w.ctxA, (s) => balanceSheet(s, { asOf: '2025-12-31' }));
    expect(before.assets.find((l) => l.code === '1000')).toBeUndefined();
  });
});
