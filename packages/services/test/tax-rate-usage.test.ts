import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContact, createDraftInvoice, createItem, createPayment, createTaxRate, issueInvoice, listTaxRates, updateItem, updateTaxRate, voidInvoice } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let customerId: string;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Usage Customer', isCustomer: true, isVendor: false }))).id;
});
afterAll(() => w.destroy());

async function invoice(taxRateIds: string[][], issue = true) {
  const draft = await w.run(w.ctxA, (s) =>
    createDraftInvoice(s, {
      contactId: customerId,
      issueDate: '2026-06-01',
      lines: taxRateIds.map((ids, i) => ({ description: `Line ${i + 1}`, quantity: '1', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: ids })),
    }),
  );
  return issue ? w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version })) : draft;
}

const usageOf = async (id: string, opts: { includeInactive?: boolean } = {}) => (await w.run(w.ctxA, (s) => listTaxRates(s, { ...opts, withUsage: true }))).find((t) => t.id === id)?.usage;

describe('tax rate usage', () => {
  it('counts active items and open (issued, unpaid) invoices per rate in the list', async () => {
    const state = await w.run(w.ctxA, (s) => createTaxRate(s, { name: 'State', rate: '0.06' }));
    const county = await w.run(w.ctxA, (s) => createTaxRate(s, { name: 'County', rate: '0.01' }));
    const unused = await w.run(w.ctxA, (s) => createTaxRate(s, { name: 'Unused', rate: '0.02' }));

    await w.run(w.ctxA, (s) => createItem(s, { name: 'Both', kind: 'service', unitPrice: '10', incomeAccountId: acct.get('4100')!, defaultTaxRateIds: [state.id, county.id] }));
    await w.run(w.ctxA, (s) => createItem(s, { name: 'State only', kind: 'service', unitPrice: '10', incomeAccountId: acct.get('4100')!, defaultTaxRateIds: [state.id] }));
    const archived = await w.run(w.ctxA, (s) => createItem(s, { name: 'Archived', kind: 'service', unitPrice: '10', incomeAccountId: acct.get('4100')!, defaultTaxRateIds: [state.id] }));
    await w.run(w.ctxA, (s) => updateItem(s, archived.id, { version: archived.version, isActive: false }));

    // Two lines with the same rate on one invoice count once.
    await invoice([[state.id], [state.id, county.id]]);
    await invoice([[state.id]]);
    // Not open: a draft, a paid invoice and a voided one.
    await invoice([[state.id]], false);
    const paid = await invoice([[county.id]]);
    await w.run(w.ctxA, (s) => createPayment(s, { date: '2026-06-02', amount: paid.total, depositAccountId: acct.get('1000')!, method: 'check', isRefundableDeposit: false, allocations: [{ invoiceId: paid.id, amount: paid.total }] }));
    const voided = await invoice([[county.id]]);
    await w.run(w.ctxA, (s) => voidInvoice(s, voided.id, { version: voided.version, reason: 'Mistake' }));

    expect(await usageOf(state.id)).toEqual({ items: 2, openInvoices: 2 });
    expect(await usageOf(county.id)).toEqual({ items: 1, openInvoices: 1 });
    expect(await usageOf(unused.id)).toEqual({ items: 0, openInvoices: 0 });

    // Inactive rates still report usage when listed; the plain list omits the field.
    await w.run(w.ctxA, (s) => updateTaxRate(s, county.id, { version: county.version, isActive: false }));
    expect(await usageOf(county.id, { includeInactive: true })).toEqual({ items: 1, openInvoices: 1 });
    const plain = await w.run(w.ctxA, (s) => listTaxRates(s));
    expect(plain.every((t) => t.usage === undefined)).toBe(true);
  });

  it("never counts another company's items or invoices", async () => {
    const bRate = await w.run(w.ctxB, (s) => createTaxRate(s, { name: 'State', rate: '0.06' }));
    const bRates = await w.run(w.ctxB, (s) => listTaxRates(s, { includeInactive: true, withUsage: true }));
    expect(bRates.map((t) => t.id)).toEqual([bRate.id]);
    expect(bRates[0]!.usage).toEqual({ items: 0, openInvoices: 0 });
  });
});
