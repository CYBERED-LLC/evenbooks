import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withCompany } from '@evenbooks/db';
import { LocalStorage, LogEmailSender } from '@evenbooks/integrations';
import {
  allocatePayment,
  applyCreditNote,
  createContact,
  createDraftCreditNote,
  createDraftInvoice,
  createPayment,
  createRefund,
  createTaxRate,
  customerBalance,
  generateInvoicePdf,
  getInvoice,
  getPayment,
  getPublicInvoice,
  getPublicLink,
  ingestEmailEvent,
  issueCreditNote,
  issueInvoice,
  listAccounts,
  listInvoiceEmails,
  profitAndLoss,
  queueInvoiceEmail,
  reverseAllocation,
  sendQueuedEmail,
  updateContact,
  updateDraftInvoice,
  voidInvoice,
  voidPayment,
  voidRefund,
  getCreditNote,
  listInvoicePdfVersions,
  getContact,
  revokePublicLink,
  verifyCashRecognition,
  rebuildCashRecognition,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let customerId: string;
let taxId: string;
let storage: LocalStorage;
let tmpDir: string;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Acme Corp', isCustomer: true, isVendor: false, email: 'ap@acme.test' }))).id;
  taxId = (await w.run(w.ctxA, (s) => createTaxRate(s, { name: 'Sales tax 10%', rate: '0.10' }))).id;
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-sales-'));
  storage = new LocalStorage(tmpDir);
});
afterAll(async () => {
  await w.destroy();
  await rm(tmpDir, { recursive: true, force: true });
});

const bal = async (code: string) => Number((await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true }))).find((a) => a.code === code)!.balance).toFixed(2);
const pl = (basis: 'cash' | 'accrual', from = '2026-01-01', to = '2026-12-31') => w.run(w.ctxA, (s) => profitAndLoss(s, { from, to, basis }));
const cashIncome = async (from?: string, to?: string) => Number((await pl('cash', from, to)).totalIncome).toFixed(2);
const accrualIncome = async (from?: string, to?: string) => Number((await pl('accrual', from, to)).totalIncome).toFixed(2);

async function issue(lines: { unitPrice: string; quantity?: string; taxed?: boolean; discount?: { type: 'percent' | 'fixed'; value: string } }[], opts: { issueDate?: string; documentDiscount?: { type: 'percent' | 'fixed'; value: string } } = {}) {
  const draft = await w.run(w.ctxA, (s) =>
    createDraftInvoice(s, {
      contactId: customerId,
      issueDate: opts.issueDate ?? '2026-06-01',
      lines: lines.map((l, i) => ({ description: `Line ${i + 1}`, quantity: l.quantity ?? '1', unitPrice: l.unitPrice, discount: l.discount ?? null, incomeAccountId: acct.get('4100')!, taxRateIds: l.taxed ? [taxId] : [] })),
      documentDiscount: opts.documentDiscount ?? null,
    }),
  );
  return w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
}

describe('invoice lifecycle', () => {
  it('drafts are editable and deletable; issuing posts AR / income / tax with sequential numbers', async () => {
    const draft = await w.run(w.ctxA, (s) =>
      createDraftInvoice(s, { contactId: customerId, issueDate: '2026-05-01', lines: [{ description: 'Consulting', quantity: '10', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: [taxId] }] }),
    );
    expect(draft.status).toBe('draft');
    expect(draft.number).toBeNull();
    expect(draft.total).toBe('1100.00');
    expect(draft.dueDate).toBe('2026-05-31');
    const edited = await w.run(w.ctxA, (s) => updateDraftInvoice(s, draft.id, { version: draft.version, memo: 'Thanks', lines: [{ description: 'Consulting', quantity: '10', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: [taxId] }, { description: 'Untaxed', quantity: '1', unitPrice: '50', incomeAccountId: acct.get('4000')!, taxRateIds: [] }] }));
    expect(edited.total).toBe('1150.00');
    expect(edited.taxSummary[0]!.taxable).toBe('1000.00');
    const issued = await w.run(w.ctxA, (s) => issueInvoice(s, edited.id, { version: edited.version }));
    expect(issued.status).toBe('issued');
    expect(issued.number).toBe('INV-0001');
    expect(issued.balanceDue).toBe('1150.00');
    expect(await bal('1100')).toBe('1150.00');
    expect(await bal('4100')).toBe('1000.00');
    expect(await bal('4000')).toBe('50.00');
    expect(await bal('2100')).toBe('100.00');
    expect(await accrualIncome('2026-05-01', '2026-05-31')).toBe('1050.00');
    expect(await cashIncome('2026-05-01', '2026-05-31')).toBe('0.00');

    await expect(w.run(w.ctxA, (s) => updateDraftInvoice(s, issued.id, { version: issued.version, memo: 'x' }))).rejects.toMatchObject({ code: 'immutable' });
    // database blocks direct edits of issued invoices and their lines
    await expect(withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`update invoices set total = 1 where id = ${issued.id}`))).rejects.toThrow();
    await expect(withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`update invoice_lines set unit_price = 1 where invoice_id = ${issued.id}`))).rejects.toThrow();

    const second = await issue([{ unitPrice: '200' }]);
    expect(second.number).toBe('INV-0002');
  });

  it('refuses to issue a zero-total invoice and lets only issued invoices be voided', async () => {
    const zero = await w.run(w.ctxA, (s) => createDraftInvoice(s, { contactId: customerId, issueDate: '2026-05-02', lines: [{ description: 'Free', quantity: '1', unitPrice: '0', incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }));
    await expect(w.run(w.ctxA, (s) => issueInvoice(s, zero.id, { version: zero.version }))).rejects.toMatchObject({ code: 'validation' });
    const inv = await issue([{ unitPrice: '75' }]);
    const arBefore = await bal('1100');
    const voided = await w.run(w.ctxA, (s) => voidInvoice(s, inv.id, { version: inv.version, reason: 'Sent to wrong customer' }));
    expect(voided.status).toBe('void');
    expect(voided.hasPublicLink).toBe(false);
    expect(Number(await bal('1100'))).toBe(Number(arBefore) - 75);
  });
});

describe('payments and the plan fixture', () => {
  it('$1,000 + $100 tax with a $550 payment recognizes $500 cash revenue and $50 tax', async () => {
    const inv = await issue([{ unitPrice: '1000', taxed: true }], { issueDate: '2026-07-01' });
    expect(inv.total).toBe('1100.00');
    const cashBefore = await cashIncome('2026-07-01', '2026-07-31');
    const p = await w.run(w.ctxA, (s) => createPayment(s, { date: '2026-07-10', amount: '550', depositAccountId: acct.get('1000')!, allocations: [{ invoiceId: inv.id, amount: '550' }], method: 'check', isRefundableDeposit: false }));
    expect(p.amountAllocated).toBe('550.00');
    expect(p.unappliedAmount).toBe('0.00');
    const after = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(after.balanceDue).toBe('550.00');
    expect(after.status).toBe('issued');
    const cash = await pl('cash', '2026-07-01', '2026-07-31');
    expect((Number(cash.totalIncome) - Number(cashBefore)).toFixed(2)).toBe('500.00');
    expect(cash.salesTaxCollected).toBe('50.00');
    expect(await accrualIncome('2026-07-01', '2026-07-31')).toBe('1000.00');

    // second payment settles the rest; cumulative recognition adds exactly to the totals
    await w.run(w.ctxA, (s) => createPayment(s, { date: '2026-07-20', amount: '550', depositAccountId: acct.get('1000')!, allocations: [{ invoiceId: inv.id, amount: '550' }], method: 'check', isRefundableDeposit: false }));
    const paid = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(paid.status).toBe('paid');
    expect(paid.balanceDue).toBe('0.00');
    const cash2 = await pl('cash', '2026-07-01', '2026-07-31');
    expect((Number(cash2.totalIncome) - Number(cashBefore)).toFixed(2)).toBe('1000.00');
    expect(cash2.salesTaxCollected).toBe('100.00');
  });

  it('a combined payment settles two invoices with an overpayment held as advance income, then applied', async () => {
    const a = await issue([{ unitPrice: '300' }], { issueDate: '2026-08-01' });
    const b = await issue([{ unitPrice: '200' }], { issueDate: '2026-08-02' });
    const p = await w.run(w.ctxA, (s) =>
      createPayment(s, { contactId: customerId, date: '2026-08-05', amount: '600', depositAccountId: acct.get('1000')!, method: 'ach', isRefundableDeposit: false, allocations: [{ invoiceId: a.id, amount: '300' }, { invoiceId: b.id, amount: '200' }] }),
    );
    expect(p.unappliedAmount).toBe('100.00');
    expect(await bal('2200')).toBe('100.00');
    const cashAug = await pl('cash', '2026-08-01', '2026-08-31');
    expect(cashAug.totalIncome).toBe('600.00'); // 500 invoice income + 100 advance
    expect(cashAug.income.find((l) => l.code === '4950')!.amount).toBe('100.00');

    const c = await issue([{ unitPrice: '100' }], { issueDate: '2026-08-10' });
    const applied = await w.run(w.ctxA, (s) => allocatePayment(s, p.id, { version: p.version, date: '2026-08-12', allocations: [{ invoiceId: c.id, amount: '100' }] }));
    expect(applied.unappliedAmount).toBe('0.00');
    expect(await bal('2200')).toBe('0.00');
    const cashAug2 = await pl('cash', '2026-08-01', '2026-08-31');
    expect(cashAug2.totalIncome).toBe('600.00'); // unchanged total; reclassified
    expect(cashAug2.income.find((l) => l.code === '4950')).toBeUndefined();
    expect(cashAug2.income.find((l) => l.code === '4100')!.amount).toBe('600.00');

    // reverse the last allocation: funds are unapplied again and become advance income again
    const alloc = applied.allocations.find((x) => x.invoiceId === c.id)!;
    const reversed = await w.run(w.ctxA, (s) => reverseAllocation(s, alloc.id, { reason: 'Wrong invoice', date: '2026-08-13' }));
    expect(reversed.unappliedAmount).toBe('100.00');
    expect((await w.run(w.ctxA, (s) => getInvoice(s, c.id))).balanceDue).toBe('100.00');
    const cashAug3 = await pl('cash', '2026-08-01', '2026-08-31');
    expect(cashAug3.income.find((l) => l.code === '4950')!.amount).toBe('100.00');
    expect(cashAug3.totalIncome).toBe('600.00');

    // over-allocation is rejected
    await expect(w.run(w.ctxA, (s) => allocatePayment(s, p.id, { version: reversed.version, allocations: [{ invoiceId: c.id, amount: '150' }] }))).rejects.toMatchObject({ code: 'over_allocation' });
    // voiding with allocations is blocked
    await expect(w.run(w.ctxA, (s) => voidPayment(s, p.id, { version: reversed.version, reason: 'x' }))).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('discounts reduce recorded revenue before tax and settle proportionally', async () => {
    const inv = await issue([{ unitPrice: '200', taxed: true, discount: { type: 'percent', value: '10' } }, { unitPrice: '100', taxed: true }], { issueDate: '2026-09-01', documentDiscount: { type: 'fixed', value: '20' } });
    // after line discount: 180 + 100 = 280; doc discount 20 → net 260; tax 26
    expect(inv.netTotal).toBe('260.00');
    expect(inv.taxTotal).toBe('26.00');
    expect(inv.total).toBe('286.00');
    expect(inv.discountTotal).toBe('40.00');
    const p = await w.run(w.ctxA, (s) => createPayment(s, { date: '2026-09-05', amount: '143', depositAccountId: acct.get('1000')!, allocations: [{ invoiceId: inv.id, amount: '143' }], method: 'card', isRefundableDeposit: false }));
    expect(p.amountAllocated).toBe('143.00');
    const cash = await pl('cash', '2026-09-01', '2026-09-30');
    expect(cash.totalIncome).toBe('130.00');
    expect(cash.salesTaxCollected).toBe('13.00');
  });

  it('refundable deposits are not income until applied; refunds reverse advance income', async () => {
    const dep = await w.run(w.ctxA, (s) => createPayment(s, { contactId: customerId, date: '2026-10-01', amount: '500', depositAccountId: acct.get('1000')!, method: 'wire', isRefundableDeposit: true, allocations: [] }));
    expect(dep.unappliedAmount).toBe('500.00');
    expect(await cashIncome('2026-10-01', '2026-10-31')).toBe('0.00');
    const inv = await issue([{ unitPrice: '400' }], { issueDate: '2026-10-05' });
    await w.run(w.ctxA, (s) => allocatePayment(s, dep.id, { version: dep.version, date: '2026-10-06', allocations: [{ invoiceId: inv.id, amount: '400' }] }));
    expect(await cashIncome('2026-10-01', '2026-10-31')).toBe('400.00');
    // refund the remaining 100 of the refundable deposit: no income effect
    const afterApply = await w.run(w.ctxA, (s) => getPayment(s, dep.id));
    const refund = await w.run(w.ctxA, (s) => createRefund(s, { sourceType: 'payment', sourceId: dep.id, date: '2026-10-10', amount: '100', fromAccountId: acct.get('1000')!, method: 'wire' }));
    expect(refund.status).toBe('posted');
    expect((await w.run(w.ctxA, (s) => getPayment(s, dep.id))).unappliedAmount).toBe('0.00');
    expect(await cashIncome('2026-10-01', '2026-10-31')).toBe('400.00');
    expect(afterApply.amountRefunded).toBe('0.00');

    // a normal advance refunded later reduces cash income in the refund month
    const adv = await w.run(w.ctxA, (s) => createPayment(s, { contactId: customerId, date: '2026-11-01', amount: '250', depositAccountId: acct.get('1000')!, method: 'cash', isRefundableDeposit: false, allocations: [] }));
    expect(await cashIncome('2026-11-01', '2026-11-30')).toBe('250.00');
    const r2 = await w.run(w.ctxA, (s) => createRefund(s, { sourceType: 'payment', sourceId: adv.id, date: '2026-12-01', amount: '250', fromAccountId: acct.get('1000')!, method: 'cash' }));
    expect(await cashIncome('2026-12-01', '2026-12-31')).toBe('-250.00');
    await expect(w.run(w.ctxA, (s) => createRefund(s, { sourceType: 'payment', sourceId: adv.id, date: '2026-12-02', amount: '1', fromAccountId: acct.get('1000')!, method: 'cash' }))).rejects.toMatchObject({ code: 'over_allocation' });
    const undone = await w.run(w.ctxA, (s) => voidRefund(s, r2.id, { reason: 'Refunded twice' }));
    expect(undone.status).toBe('void');
    expect(await cashIncome('2026-12-01', '2026-12-31')).toBe('0.00');
    // now the advance can be voided (no allocations, refunds voided)
    const advNow = await w.run(w.ctxA, (s) => getPayment(s, adv.id));
    const voided = await w.run(w.ctxA, (s) => voidPayment(s, adv.id, { version: advNow.version, reason: 'Duplicate entry', date: '2026-12-03' }));
    expect(voided.status).toBe('void');
    expect(await cashIncome('2026-11-01', '2026-12-31')).toBe('0.00');
  });
});

describe('credit notes', () => {
  it('applying a credit to an unpaid invoice settles it with no cash income; refunding a credit is negative income', async () => {
    const inv = await issue([{ unitPrice: '300', taxed: true }], { issueDate: '2027-01-05' });
    const draft = await w.run(w.ctxA, (s) => createDraftCreditNote(s, { contactId: customerId, invoiceId: inv.id, issueDate: '2027-01-06', reason: 'Service issue', lines: [{ description: 'Credit', quantity: '1', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: [taxId] }] }));
    expect(draft.total).toBe('110.00');
    const incomeBefore = await bal('4100');
    const depositsBefore = await bal('2200');
    const cn = await w.run(w.ctxA, (s) => issueCreditNote(s, draft.id, { version: draft.version, applyToInvoiceId: inv.id }));
    expect(cn.number).toBe('CN-0001');
    expect(cn.status).toBe('paid'); // fully applied
    expect(cn.balance).toBe('0.00');
    expect(Number(await bal('4100'))).toBe(Number(incomeBefore) - 100);
    const after = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(after.balanceDue).toBe('220.00');
    expect(await bal('2200')).toBe(depositsBefore); // credit consumed
    // cash basis: reclassification nets to zero income in January
    const jan = await pl('cash', '2027-01-01', '2027-01-31');
    expect(jan.totalIncome).toBe('0.00');
    expect(jan.salesTaxCollected).toBe('0.00');

    // standalone credit note refunded in cash → negative income + negative tax
    const standalone = await w.run(w.ctxA, (s) => createDraftCreditNote(s, { contactId: customerId, issueDate: '2027-02-01', lines: [{ description: 'Goodwill', quantity: '1', unitPrice: '50', incomeAccountId: acct.get('4100')!, taxRateIds: [taxId] }] }));
    const issuedCn = await w.run(w.ctxA, (s) => issueCreditNote(s, standalone.id, { version: standalone.version }));
    expect(issuedCn.balance).toBe('55.00');
    expect((Number(await bal('2200')) - Number(depositsBefore)).toFixed(2)).toBe('55.00');
    await w.run(w.ctxA, (s) => createRefund(s, { sourceType: 'credit_note', sourceId: issuedCn.id, date: '2027-02-03', amount: '55', fromAccountId: acct.get('1000')!, method: 'check' }));
    const feb = await pl('cash', '2027-02-01', '2027-02-28');
    expect(feb.totalIncome).toBe('-50.00');
    expect(feb.salesTaxCollected).toBe('-5.00');
    expect((await w.run(w.ctxA, (s) => getCreditNote(s, issuedCn.id))).status).toBe('paid');
    expect(await bal('2200')).toBe(depositsBefore);
  });

  it('partial credit application via applyCreditNote', async () => {
    const inv = await issue([{ unitPrice: '80' }], { issueDate: '2027-03-01' });
    const draft = await w.run(w.ctxA, (s) => createDraftCreditNote(s, { contactId: customerId, issueDate: '2027-03-02', lines: [{ description: 'Credit', quantity: '1', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }));
    const cn = await w.run(w.ctxA, (s) => issueCreditNote(s, draft.id, { version: draft.version }));
    const applied = await w.run(w.ctxA, (s) => applyCreditNote(s, cn.id, { version: cn.version, allocations: [{ invoiceId: inv.id, amount: '80' }] }));
    expect(applied.balance).toBe('20.00');
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).status).toBe('paid');
    await expect(w.run(w.ctxA, (s) => applyCreditNote(s, cn.id, { version: applied.version, allocations: [{ invoiceId: inv.id, amount: '1' }] }))).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('ledger consistency', () => {
  it('AR equals the sum of open invoice balances and customer deposits equal unapplied funds plus open credits', async () => {
    const balances = await w.run(w.ctxA, (s) => customerBalance(s, customerId));
    const ar = await bal('1100');
    expect(Number(balances.totalReceivable).toFixed(2)).toBe(ar);
    const deposits = await bal('2200');
    expect(Number(balances.totalCredits).toFixed(2)).toBe(deposits);
  });
});

describe('PDF and public link', () => {
  it('snapshots survive contact edits; regenerated PDFs are byte-identical; public link resolves and revokes', async () => {
    const inv = await issue([{ unitPrice: '120' }], { issueDate: '2027-04-01' });
    const v1 = await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, inv.id, 'test'));
    expect(v1.version).toBe(1);
    const contact = await w.run(w.ctxA, (s) => getContact(s, customerId));
    await w.run(w.ctxA, (s) => updateContact(s, customerId, { version: contact.version, name: 'Acme Corporation (renamed)', email: 'new@acme.test' }));
    const again = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(again.customerSnapshot.name).toBe('Acme Corp');
    const v2 = await w.run(w.ctxA, (s) => generateInvoicePdf(s, storage, inv.id, 'test-again'));
    expect(v2.version).toBe(2);
    expect(v2.sha256).toBe(v1.sha256);
    const versions = await w.run(w.ctxA, (s) => listInvoicePdfVersions(s, inv.id));
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    const stored = await storage.getObject(`companies/${w.companyA}/invoice_pdf/${v1.attachmentId}.pdf`);
    expect(stored?.body.subarray(0, 4).toString()).toBe('%PDF');

    const link = await w.run(w.ctxA, (s) => getPublicLink(s, inv.id, 'https://evenbooks.test'));
    expect(link.url).toMatch(/^https:\/\/evenbooks\.test\/i\/[A-Za-z0-9_-]{40,}$/);
    const token = link.path!.replace('/i/', '');
    const pub = await getPublicInvoice(w.tdb.app.db, token);
    expect(pub?.dto.number).toBe(again.number);
    expect(pub?.dto.customer.name).toBe('Acme Corp');
    expect((pub?.dto as unknown as Record<string, unknown>).journalEntryId).toBeUndefined();
    expect(await getPublicInvoice(w.tdb.app.db, 'nope')).toBeNull();
    await w.run(w.ctxA, (s) => revokePublicLink(s, inv.id));
    expect(await getPublicInvoice(w.tdb.app.db, token)).toBeNull();
  });
});

describe('email delivery states', () => {
  it('queues, sends through the log transport, retries transient failures, fails permanently, and ingests bounces', async () => {
    const inv = await issue([{ unitPrice: '60' }], { issueDate: '2027-05-01' });
    const sender = new LogEmailSender();
    const deps = { db: w.tdb.app.db, storage, sender, config: { from: 'Evenbooks <billing@test>', replyTo: null, configurationSet: null }, baseUrl: 'https://evenbooks.test' };
    const queued = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, inv.id, { to: 'customer@example.test' }, { config: deps.config, baseUrl: deps.baseUrl }));
    expect(queued.status).toBe('queued');
    const outbox = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => (await tx.execute<{ event_type: string }>(sql`select event_type from outbox_events where dedupe_key = ${'email.send:' + queued.id}`)).rows);
    expect(outbox).toEqual([{ event_type: 'email.send' }]);

    const sent = await sendQueuedEmail(deps, queued.id, null, 'job-1');
    expect(sent.status).toBe('sent');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.attachments?.[0]?.fileName).toMatch(/^INV-\d+\.pdf$/);
    expect(sender.sent[0]!.text).toContain('https://evenbooks.test/i/');
    // idempotent: sending again is a no-op
    expect((await sendQueuedEmail(deps, queued.id, null)).status).toBe('sent');
    expect(sender.sent).toHaveLength(1);

    // transient failure → stays queued (job will retry); permanent → failed
    const resend = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, inv.id, { to: 'customer@example.test', isResend: true }));
    sender.failNext = { transient: true, error: 'Throttled' };
    await expect(sendQueuedEmail(deps, resend.id, null)).rejects.toMatchObject({ code: 'external_error' });
    let msgs = await w.run(w.ctxA, (s) => listInvoiceEmails(s, inv.id));
    expect(msgs.find((m) => m.id === resend.id)!.status).toBe('queued');
    sender.failNext = { transient: false, error: 'MessageRejected' };
    expect((await sendQueuedEmail(deps, resend.id, null)).status).toBe('failed');
    msgs = await w.run(w.ctxA, (s) => listInvoiceEmails(s, inv.id));
    expect(msgs.find((m) => m.id === resend.id)!.lastError).toContain('MessageRejected');

    // bounce ingestion marks the message and suppresses the address; later sends are suppressed
    const providerId = sender.sent[0]!.providerMessageId;
    const r = await ingestEmailEvent(w.tdb.app.db, { provider: 'ses', providerMessageId: providerId, providerEventId: 'evt-1', eventType: 'Bounce', occurredAt: new Date().toISOString(), payload: {}, bounceType: 'Permanent', recipients: ['customer@example.test'] });
    expect(r.matched).toBe(true);
    msgs = await w.run(w.ctxA, (s) => listInvoiceEmails(s, inv.id));
    expect(msgs.find((m) => m.id === queued.id)!.status).toBe('bounced');
    const suppressed = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, inv.id, { to: 'Customer@Example.test', isResend: true }));
    expect(suppressed.status).toBe('suppressed');
    expect((await ingestEmailEvent(w.tdb.app.db, { provider: 'ses', providerMessageId: 'unknown', providerEventId: 'evt-2', eventType: 'Delivery', occurredAt: null, payload: {} })).matched).toBe(false);
  });
});

describe('cash recognition layer is reproducible', () => {
  it('derivation from source documents matches the stored rows, and a rebuild is a no-op for totals', async () => {
    const before = await w.run(w.ctxA, (s) => verifyCashRecognition(s));
    expect(before.diffs).toEqual([]);
    expect(before.ok).toBe(true);
    expect(before.storedRows).toBeGreaterThan(10);
    const totalsBefore = await pl('cash', '2026-01-01', '2027-12-31');
    const rebuilt = await w.run(w.ctxA, (s) => rebuildCashRecognition(s, 'test'));
    expect(rebuilt.rows).toBe(before.derivedRows);
    const totalsAfter = await pl('cash', '2026-01-01', '2027-12-31');
    expect(totalsAfter.totalIncome).toBe(totalsBefore.totalIncome);
    expect(totalsAfter.totalExpenses).toBe(totalsBefore.totalExpenses);
    expect(totalsAfter.salesTaxCollected).toBe(totalsBefore.salesTaxCollected);
    expect((await w.run(w.ctxA, (s) => verifyCashRecognition(s))).ok).toBe(true);
  });
});
