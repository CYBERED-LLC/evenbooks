import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bulkReview,
  categorizeTransaction,
  createBankAccount,
  createContact,
  createDraftInvoice,
  createManualBankTransaction,
  createPayment,
  createRule,
  getBankTransaction,
  getInvoice,
  getPayment,
  invoiceCandidates,
  listAccounts,
  listInbox,
  listPurchases,
  matchCandidates,
  matchTransaction,
  recordInvoicePayment,
  issueInvoice,
  undoReview,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let checkingId: string;
let acmeId: string;
let globexId: string;

const txn = (date: string, amount: string, description: string) =>
  w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId: checkingId, date, amount, description }));

async function invoice(contactId: string, amount: string, issueDate = '2026-05-01') {
  const draft = await w.run(w.ctxA, (s) =>
    createDraftInvoice(s, { contactId, issueDate, lines: [{ description: 'Work', quantity: '1', unitPrice: amount, discount: null, incomeAccountId: acct.get('4100')!, taxRateIds: [] }], documentDiscount: null }),
  );
  return w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
}

const balance = async (code: string) => (await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true }))).find((a) => a.code === code)!.balance;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  checkingId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! }))).id;
  acmeId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Acme Corp', isCustomer: true, isVendor: false }))).id;
  globexId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Globex LLC', isCustomer: true, isVendor: false }))).id;
});
afterAll(async () => {
  await w.destroy();
});

describe('customer deposits pay invoices', () => {
  it('offers the exact-balance invoice, the recognized customer and close amounts', async () => {
    const exact = await invoice(globexId, '500');
    const acmeSmall = await invoice(acmeId, '120');
    const close = await invoice(globexId, '470');
    await invoice(globexId, '90'); // neither close, exact nor recognized
    const dep = await txn('2026-05-10', '500', 'MOBILE DEPOSIT ACME CORP');
    const list = await w.run(w.ctxA, (s) => invoiceCandidates(s, dep.id, {}));
    expect(list[0]).toMatchObject({ invoiceId: exact.id, reason: 'exact', contactName: 'Globex LLC', balanceDue: '500.00' });
    expect(list.find((c) => c.invoiceId === acmeSmall.id)?.reason).toBe('customer');
    expect(list.find((c) => c.invoiceId === close.id)?.reason).toBe('close');
    expect(list).toHaveLength(3);
    // a chosen customer lists all of their open invoices
    const globex = await w.run(w.ctxA, (s) => invoiceCandidates(s, dep.id, { contactId: globexId }));
    expect(globex).toHaveLength(3);
    // the row hint counts the exact one, so Accept does not categorize it
    const row = (await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId, status: 'unreviewed' }))).items.find((t) => t.id === dep.id)!;
    expect(row.matchHint).toMatchObject({ invoices: 1, count: 0 });
    // money out is never an invoice payment
    const out = await txn('2026-05-10', '-500', 'RENT');
    expect(await w.run(w.ctxA, (s) => invoiceCandidates(s, out.id, {}))).toEqual([]);
  });

  it('records the payment and matches the line in one step; undo keeps the payment as a match', async () => {
    const inv = await invoice(acmeId, '300');
    const dep = await txn('2026-05-12', '300', 'DEPOSIT');
    const arBefore = await balance('1100');
    const bankBefore = await balance('1000');
    const done = await w.run(w.ctxA, (s) => recordInvoicePayment(s, dep.id, { version: dep.version, invoiceIds: [inv.id], idempotencyKey: 'pay-inv-1' }));
    expect(done.status).toBe('matched');
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).status).toBe('paid');
    expect(Number(await balance('1100'))).toBe(Number(arBefore) - 300);
    expect(Number(await balance('1000'))).toBe(Number(bankBefore) + 300);
    // a retry with the same key returns the first result
    const again = await w.run(w.ctxA, (s) => recordInvoicePayment(s, dep.id, { version: dep.version, invoiceIds: [inv.id], idempotencyKey: 'pay-inv-1' }));
    expect(again.version).toBe(done.version);
    await expect(w.run(w.ctxA, (s) => recordInvoicePayment(s, dep.id, { version: done.version, invoiceIds: [inv.id] }))).rejects.toMatchObject({ code: 'invalid_state' });

    const undone = await w.run(w.ctxA, (s) => undoReview(s, dep.id, { version: done.version, reason: 'Look again' }));
    expect(undone.status).toBe('unreviewed');
    expect(Number(await balance('1000'))).toBe(Number(bankBefore) + 300);
    const cands = await w.run(w.ctxA, (s) => matchCandidates(s, dep.id));
    expect(cands[0]).toMatchObject({ targetType: 'payment', description: `Payment from Acme Corp · ${inv.number}` });
    expect((await w.run(w.ctxA, (s) => getBankTransaction(s, dep.id))).matchHint).toMatchObject({ count: 1 });
  });

  it('a smaller deposit pays part; a larger one leaves credit for the customer', async () => {
    const inv = await invoice(acmeId, '1000');
    const part = await txn('2026-05-13', '400', 'DEPOSIT PART');
    await w.run(w.ctxA, (s) => recordInvoicePayment(s, part.id, { version: part.version, invoiceIds: [inv.id] }));
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).balanceDue).toBe('600.00');

    const big = await txn('2026-05-14', '650', 'DEPOSIT REST');
    const done = await w.run(w.ctxA, (s) => recordInvoicePayment(s, big.id, { version: big.version, invoiceIds: [inv.id] }));
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).status).toBe('paid');
    expect(done.status).toBe('matched');
    const fresh = await w.run(w.ctxA, (s) => getBankTransaction(s, big.id));
    expect(fresh.status).toBe('matched');
  });

  it('pays several invoices of one customer in due-date order and refuses mixed customers', async () => {
    const a = await invoice(acmeId, '100', '2026-05-02');
    const b = await invoice(acmeId, '200', '2026-05-03');
    const g = await invoice(globexId, '50');
    const dep = await txn('2026-05-15', '250', 'ACME CHECK');
    await expect(w.run(w.ctxA, (s) => recordInvoicePayment(s, dep.id, { version: dep.version, invoiceIds: [a.id, g.id] }))).rejects.toMatchObject({ code: 'validation' });
    await w.run(w.ctxA, (s) => recordInvoicePayment(s, dep.id, { version: dep.version, invoiceIds: [b.id, a.id] }));
    expect((await w.run(w.ctxA, (s) => getInvoice(s, a.id))).status).toBe('paid');
    expect((await w.run(w.ctxA, (s) => getInvoice(s, b.id))).balanceDue).toBe('50.00');
    // a deposit used up before the last invoice is refused
    const c = await invoice(acmeId, '80', '2026-05-04');
    const small = await txn('2026-05-16', '50', 'ACME SMALL');
    await expect(w.run(w.ctxA, (s) => recordInvoicePayment(s, small.id, { version: small.version, invoiceIds: [b.id, c.id] }))).rejects.toMatchObject({ code: 'validation' });
  });

  it('offers payments waiting in Undeposited Funds, with readable labels, and matches several to one deposit', async () => {
    const undepositedId = acct.get('1050')!;
    const inv = await invoice(globexId, '75');
    const p1 = await w.run(w.ctxA, (s) => createPayment(s, { contactId: globexId, date: '2026-05-18', amount: '75', method: 'check', depositAccountId: undepositedId, isRefundableDeposit: false, allocations: [{ invoiceId: inv.id, amount: '75' }] }));
    const p2 = await w.run(w.ctxA, (s) => createPayment(s, { contactId: acmeId, date: '2026-05-19', amount: '25', method: 'cash', depositAccountId: undepositedId, isRefundableDeposit: false, allocations: [] }));
    const dep = await txn('2026-05-20', '100', 'BRANCH DEPOSIT');
    const cands = await w.run(w.ctxA, (s) => matchCandidates(s, dep.id));
    const one = cands.find((c) => c.targetId === p1.id)!;
    expect(one).toMatchObject({ targetType: 'payment', undeposited: true, description: `Payment from Globex LLC · ${inv.number}` });
    expect(cands.find((c) => c.targetId === p2.id)?.description).toBe('Payment from Acme Corp');
    const done = await w.run(w.ctxA, (s) => matchTransaction(s, dep.id, { version: dep.version, targets: [{ targetType: 'payment', targetId: p1.id }, { targetType: 'payment', targetId: p2.id }] }));
    expect(done.status).toBe('matched');
    expect((await w.run(w.ctxA, (s) => getPayment(s, p1.id))).status).toBe('posted');

    // an exact waiting payment flags the row as already recorded
    const p3 = await w.run(w.ctxA, (s) => createPayment(s, { contactId: acmeId, date: '2026-05-21', amount: '42', method: 'check', depositAccountId: undepositedId, isRefundableDeposit: false, allocations: [] }));
    const dep2 = await txn('2026-05-22', '42', 'DEPOSIT 42');
    const row = await w.run(w.ctxA, (s) => getBankTransaction(s, dep2.id));
    expect(row.matchHint).toMatchObject({ count: 1, topScore: 90 });
    expect((await w.run(w.ctxA, (s) => matchCandidates(s, dep2.id))).find((c) => c.targetId === p3.id)?.score).toBeGreaterThanOrEqual(90);
  });
});

describe('personal spending and receipts', () => {
  it('money out to Owner’s Draws records a draw, not an expense', async () => {
    const draws = acct.get('3100')!;
    const line = await txn('2026-06-01', '-60', 'GROCERY MART');
    const before = (await w.run(w.ctxA, (s) => listPurchases(s, { limit: 100 }))).items.length;
    const drawsBefore = Number(await balance('3100'));
    const done = await w.run(w.ctxA, (s) => categorizeTransaction(s, line.id, { version: line.version, lines: [{ accountId: draws, amount: '60', description: '' }] }));
    expect(done.status).toBe('categorized');
    expect((await w.run(w.ctxA, (s) => listPurchases(s, { limit: 100 }))).items.length).toBe(before);
    expect(Math.abs(Number(await balance('3100')) - drawsBefore)).toBe(60);
    const undone = await w.run(w.ctxA, (s) => undoReview(s, line.id, { version: done.version }));
    expect(undone.status).toBe('unreviewed');
    expect(Number(await balance('3100'))).toBe(drawsBefore);
  });

  it('money in to Owner’s Equity records a contribution', async () => {
    const line = await txn('2026-06-02', '1000', 'TRANSFER FROM PERSONAL');
    const equityBefore = Number(await balance('3000'));
    const done = await w.run(w.ctxA, (s) => categorizeTransaction(s, line.id, { version: line.version, lines: [{ accountId: acct.get('3000')!, amount: '1000', description: '' }] }));
    expect(done.status).toBe('categorized');
    expect(Math.abs(Number(await balance('3000')) - equityBefore)).toBe(1000);
  });
});

describe('bulk accept', () => {
  it('refuses lines that look already recorded', async () => {
    await w.run(w.ctxA, (s) => createRule(s, { name: 'Deposits', priority: 100, direction: 'in', matchField: 'description', matchType: 'contains', pattern: 'STRIPE', accountId: acct.get('4100')! }));
    await invoice(acmeId, '333.33');
    const hinted = await txn('2026-06-03', '333.33', 'STRIPE PAYOUT A');
    const plain = await txn('2026-06-03', '12.34', 'STRIPE PAYOUT B');
    const res = await w.run(w.ctxA, (s) => bulkReview(s, { action: 'accept_suggestion', items: [{ id: hinted.id, version: hinted.version }, { id: plain.id, version: plain.version }] }));
    expect(res.results.find((r) => r.id === hinted.id)).toMatchObject({ ok: false, error: { code: 'duplicate' } });
    expect(res.results.find((r) => r.id === plain.id)?.ok).toBe(true);
  });
});
