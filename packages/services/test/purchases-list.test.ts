import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContact, createPurchase, listPurchases } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
});
afterAll(async () => {
  await w.destroy();
});

describe('listPurchases filters', () => {
  it('accountId matches the paid-from account as well as line accounts', async () => {
    const vendor = await w.run(w.ctxA, (s) => createContact(s, { name: 'Filter Vendor', isCustomer: false, isVendor: true }));
    const bank = await w.run(w.ctxA, (s) =>
      createPurchase(s, { date: '2026-05-01', contactId: vendor.id, paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5110')!, description: 'Paper', amount: '10' }], attachmentIds: [] }),
    );
    const card = await w.run(w.ctxA, (s) =>
      createPurchase(s, { date: '2026-05-02', paidFromAccountId: acct.get('2000')!, direction: 'outflow', lines: [{ accountId: acct.get('5160')!, description: 'SaaS', amount: '20' }], attachmentIds: [] }),
    );

    const byPaidFrom = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 50, accountId: acct.get('2000')! }));
    expect(byPaidFrom.items.map((p) => p.id)).toEqual([card.id]);

    const byLine = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 50, accountId: acct.get('5110')! }));
    expect(byLine.items.map((p) => p.id)).toEqual([bank.id]);

    // The purchase form reads a vendor's latest receipt this way to prefill defaults.
    const latest = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 1, contactId: vendor.id }));
    expect(latest.items).toHaveLength(1);
    expect(latest.items[0]!.paidFromAccountId).toBe(acct.get('1000'));
    expect(latest.items[0]!.lines[0]!.accountId).toBe(acct.get('5110'));
  });
});
