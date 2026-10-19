import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bulkReview,
  createBankAccount,
  createManualBankTransaction,
  createPurchase,
  createRule,
  getBankTransaction,
  listInbox,
  listPurchases,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let checkingId: string;
let savingsId: string;

const txn = (bankAccountId: string, date: string, amount: string, description: string) =>
  w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId, date, amount, description }));

const inbox = (q: Parameters<typeof listInbox>[1] extends infer T ? Partial<T> : never = {}) =>
  w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId, ...q }));

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  checkingId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! }))).id;
  savingsId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Savings', kind: 'bank', newLedgerAccount: { code: '1010', name: 'Savings' } }))).id;
  await w.run(w.ctxA, (s) =>
    createRule(s, { name: 'Coffee', priority: 100, direction: 'out', matchField: 'description', matchType: 'contains', pattern: 'COFFEE', accountId: acct.get('5140')! }),
  );
  await txn(checkingId, '2026-04-01', '-4.50', 'BLUE COFFEE #0412');
  await txn(checkingId, '2026-04-02', '-5.25', 'BLUE COFFEE #0413');
  await txn(checkingId, '2026-04-03', '-80.00', 'HARDWARE STORE');
  await txn(checkingId, '2026-04-04', '1200.00', 'CLIENT DEPOSIT');
  await txn(checkingId, '2026-04-05', '-250.00', 'TRANSFER TO SAVINGS');
  await txn(savingsId, '2026-04-06', '250.00', 'TRANSFER FROM CHECKING');
});
afterAll(async () => {
  await w.destroy();
});

describe('inbox list', () => {
  it('counts follow the search and date filters and report rule suggestions', async () => {
    const all = await inbox({ status: 'unreviewed' });
    expect(all.counts.unreviewed).toBe(5);
    expect(all.suggestedCount).toBe(2);
    const coffee = await inbox({ status: 'unreviewed', q: 'coffee' });
    expect(coffee.items).toHaveLength(2);
    expect(coffee.counts.unreviewed).toBe(2);
    const dated = await inbox({ status: 'unreviewed', from: '2026-04-03', to: '2026-04-04' });
    expect(dated.counts.unreviewed).toBe(2);
    expect(dated.suggestedCount).toBe(0);
  });

  it('a number in the search also matches the amount, and min/max filter by size', async () => {
    const byAmount = await inbox({ q: '$1,200' });
    expect(byAmount.items.map((t) => t.description)).toEqual(['CLIENT DEPOSIT']);
    const cents = await inbox({ q: '4.50' });
    expect(cents.items.map((t) => t.description)).toEqual(['BLUE COFFEE #0412']);
    const range = await inbox({ amountMin: '5', amountMax: '100' });
    expect(range.items.map((t) => t.description).sort()).toEqual(['BLUE COFFEE #0413', 'HARDWARE STORE']);
    // "%" and "_" are literal characters, not wildcards
    expect((await inbox({ q: '%' })).items).toHaveLength(0);
  });

  it('flags likely matches and transfer counterparts without loading candidates', async () => {
    await w.run(w.ctxA, (s) =>
      createPurchase(s, { date: '2026-04-02', paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5110')!, description: 'Tools', amount: '80' }], attachmentIds: [] }),
    );
    const list = await inbox({ status: 'unreviewed' });
    const hardware = list.items.find((t) => t.description === 'HARDWARE STORE')!;
    expect(hardware.matchHint).toEqual({ count: 1, topScore: 95, transfers: 0, invoices: 0 });
    const transfer = list.items.find((t) => t.description === 'TRANSFER TO SAVINGS')!;
    expect(transfer.matchHint).toMatchObject({ count: 0, transfers: 1 });
    expect(list.items.find((t) => t.description === 'CLIENT DEPOSIT')!.matchHint).toBeNull();
  });
});

describe('bulk review', () => {
  it('accepts rule suggestions per item and reports failures without undoing the rest', async () => {
    const list = await inbox({ status: 'unreviewed' });
    const coffees = list.items.filter((t) => t.suggestion);
    const deposit = list.items.find((t) => t.description === 'CLIENT DEPOSIT')!;
    expect(coffees).toHaveLength(2);
    const stale = { id: coffees[1]!.id, version: coffees[1]!.version + 7 };
    const res = await w.run(w.ctxA, (s) =>
      bulkReview(s, {
        action: 'accept_suggestion',
        items: [{ id: coffees[0]!.id, version: coffees[0]!.version }, stale, { id: deposit.id, version: deposit.version }],
        idempotencyKey: 'bulk-accept-0001',
      }),
    );
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(2);
    expect(res.results[0]).toMatchObject({ ok: true, transaction: { status: 'categorized' } });
    expect(res.results[1]).toMatchObject({ ok: false, error: { code: 'version_conflict' } });
    expect(res.results[2]).toMatchObject({ ok: false, error: { code: 'validation' } });
    // the failed lines are untouched and the good one really posted
    expect((await w.run(w.ctxA, (s) => getBankTransaction(s, coffees[1]!.id))).status).toBe('unreviewed');
    const purchases = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 50 }));
    expect(purchases.items.filter((p) => p.bankTransactionId === coffees[0]!.id)).toHaveLength(1);

    // replaying the same key returns the stored result and posts nothing new
    const again = await w.run(w.ctxA, (s) =>
      bulkReview(s, {
        action: 'accept_suggestion',
        items: [{ id: coffees[0]!.id, version: coffees[0]!.version }, stale, { id: deposit.id, version: deposit.version }],
        idempotencyKey: 'bulk-accept-0001',
      }),
    );
    expect(again).toEqual(res);
    const after = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 50 }));
    expect(after.items.filter((p) => p.bankTransactionId === coffees[0]!.id)).toHaveLength(1);
    await expect(
      w.run(w.ctxA, (s) => bulkReview(s, { action: 'exclude', reason: 'x', items: [{ id: deposit.id, version: deposit.version }], idempotencyKey: 'bulk-accept-0001' })),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('categorizes to one account, excludes, and undoes in bulk', async () => {
    const list = await inbox({ status: 'unreviewed' });
    const coffee = list.items.find((t) => t.description.startsWith('BLUE COFFEE'))!;
    const hardware = list.items.find((t) => t.description === 'HARDWARE STORE')!;
    const deposit = list.items.find((t) => t.description === 'CLIENT DEPOSIT')!;
    const cat = await w.run(w.ctxA, (s) =>
      bulkReview(s, { action: 'categorize', accountId: acct.get('5110')!, items: [{ id: coffee.id, version: coffee.version }, { id: hardware.id, version: hardware.version }], idempotencyKey: 'bulk-cat-00001' }),
    );
    expect(cat.succeeded).toBe(2);

    const ex = await w.run(w.ctxA, (s) => bulkReview(s, { action: 'exclude', reason: 'Duplicate', items: [{ id: deposit.id, version: deposit.version }, { id: deposit.id, version: deposit.version }] }));
    expect(ex.results.map((r) => r.ok)).toEqual([true, false]);
    expect(ex.results[1]!.error!.code).toBe('duplicate');
    expect(ex.results[0]!.transaction!.excludedReason).toBe('Duplicate');

    const reviewed = [...cat.results, ex.results[0]!].map((r) => ({ id: r.id, version: r.transaction!.version }));
    const undo = await w.run(w.ctxA, (s) => bulkReview(s, { action: 'undo', items: reviewed, idempotencyKey: 'bulk-undo-0001' }));
    expect(undo.succeeded).toBe(3);
    expect(undo.results.every((r) => r.transaction!.status === 'unreviewed')).toBe(true);
    const purchases = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 50 }));
    expect(purchases.items.find((p) => p.bankTransactionId === hardware.id)?.status).toBe('void');
    const counts = (await inbox({})).counts;
    expect(counts.excluded ?? 0).toBe(0);
    expect(counts.categorized).toBe(1);
  });
});
