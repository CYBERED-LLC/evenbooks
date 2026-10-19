import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContact, createDraftInvoice, createPayment, getInvoice, issueInvoice, listAccounts, profitAndLoss, reverseAllocation, verifyCashRecognition, voidPayment } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let customerId: string;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Void Co', isCustomer: true, isVendor: false }))).id;
});
afterAll(() => w.destroy());

const bal = async (code: string) => Number((await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true }))).find((a) => a.code === code)!.balance).toFixed(2);
const cashIncome = async () => Number((await w.run(w.ctxA, (s) => profitAndLoss(s, { from: '2026-03-01', to: '2026-03-31', basis: 'cash' }))).totalIncome).toFixed(2);

describe('voiding a payment', () => {
  it('after its allocation was reversed, leaves receivables, customer deposits and cash income as if it never happened', async () => {
    const draft = await w.run(w.ctxA, (s) =>
      createDraftInvoice(s, { contactId: customerId, issueDate: '2026-03-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '400', incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }),
    );
    const inv = await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
    const before = { ar: await bal('1100'), deposits: await bal('2200'), bank: await bal('1000'), cash: await cashIncome() };
    expect(before.ar).toBe('400.00');

    // 500 received: 400 applied to the invoice, 100 kept as credit.
    const p = await w.run(w.ctxA, (s) =>
      createPayment(s, { contactId: customerId, date: '2026-03-05', amount: '500', depositAccountId: acct.get('1000')!, method: 'check', isRefundableDeposit: false, allocations: [{ invoiceId: inv.id, amount: '400' }] }),
    );
    expect(await bal('1100')).toBe('0.00');
    expect(await bal('2200')).toBe('100.00');
    expect(await cashIncome()).toBe('500.00');

    // Take it off the invoice, then void it.
    const reversed = await w.run(w.ctxA, (s) => reverseAllocation(s, p.allocations[0]!.id, { reason: 'Wrong invoice', date: '2026-03-06' }));
    expect(reversed.unappliedAmount).toBe('500.00');
    expect(await bal('1100')).toBe('400.00');
    expect(await bal('2200')).toBe('500.00');
    const voided = await w.run(w.ctxA, (s) => voidPayment(s, p.id, { version: reversed.version, reason: 'Bounced check', date: '2026-03-07' }));
    expect(voided.status).toBe('void');
    expect(voided.voidJournalEntryId).toBeTruthy();

    expect(await bal('1100')).toBe(before.ar);
    expect(await bal('2200')).toBe(before.deposits);
    expect(await bal('1000')).toBe(before.bank);
    expect(await cashIncome()).toBe(before.cash);
    const open = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(open.status).toBe('issued');
    expect(open.balanceDue).toBe('400.00');
    const check = await w.run(w.ctxA, (s) => verifyCashRecognition(s));
    expect(check.ok).toBe(true);
  });

  it('a payment that was never applied still voids cleanly', async () => {
    const before = { deposits: await bal('2200'), bank: await bal('1000'), cash: await cashIncome() };
    const p = await w.run(w.ctxA, (s) => createPayment(s, { contactId: customerId, date: '2026-03-10', amount: '75', depositAccountId: acct.get('1000')!, method: 'cash', isRefundableDeposit: false, allocations: [] }));
    await w.run(w.ctxA, (s) => voidPayment(s, p.id, { version: p.version, reason: 'Duplicate' }));
    expect(await bal('2200')).toBe(before.deposits);
    expect(await bal('1000')).toBe(before.bank);
    expect(await cashIncome()).toBe(before.cash);
  });
});
