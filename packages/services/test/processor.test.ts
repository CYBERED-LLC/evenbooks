import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { FixturePaymentProcessor, LocalStorage, LogEmailSender } from '@evenbooks/integrations';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PLATFORM_FEE } from '@evenbooks/domain';
import type { ProcessorEvent } from '@evenbooks/integrations';
import {
  connectProcessor,
  createBankAccount,
  createContact,
  createDraftInvoice,
  createManualBankTransaction,
  createPayment,
  createPublicCheckout,
  getInvoice,
  getPayment,
  getProcessorCharge,
  getProcessorConnection,
  getPublicInvoice,
  getPublicLink,
  ingestProcessorEvent,
  issueInvoice,
  listAccounts,
  listProcessorCharges,
  listProcessorPayouts,
  matchCandidates,
  matchTransaction,
  refundProcessorCharge,
  refreshProcessorConnection,
  retryProcessorEvents,
  settlePendingChargeFees,
  updateProcessorConnection,
  voidPayment,
  verifyCashRecognition,
  jobStatus,
  disconnectProcessor,
  linkProcessorAccount,
  startProcessorLink,
  profitAndLoss,
  queueInvoiceEmail,
  sendQueuedEmail,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let customerId: string;
let checkingId: string;
const client = new FixturePaymentProcessor('https://evenbooks.test');
const deps = { client, feeConfig: DEFAULT_PLATFORM_FEE };
let accountId: string;

const ingestAll = async (events: ProcessorEvent[]) => {
  const out = [];
  for (const e of events) out.push(await ingestProcessorEvent(w.tdb.app.db, deps, e));
  return out;
};

async function balance(ctx = w.ctxA, code: string): Promise<string> {
  const list = await w.run(ctx, (s) => listAccounts(s, { withBalances: true, includeArchived: true }));
  return list.find((a) => a.code === code)!.balance!;
}
async function balanceOfRole(role: string): Promise<string> {
  const list = await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true, includeArchived: true }));
  return list.find((a) => a.role === role)!.balance!;
}

async function issuedInvoice(amount: string) {
  const draft = await w.run(w.ctxA, (s) => createDraftInvoice(s, { contactId: customerId, issueDate: '2026-09-01', lines: [{ description: 'Consulting', quantity: '1', unitPrice: amount, incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }));
  const inv = await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
  const link = await w.run(w.ctxA, (s) => getPublicLink(s, inv.id, 'https://evenbooks.test'));
  const token = link.path!.split('/').pop()!;
  return { inv, token };
}

async function checkout(token: string, amount?: string, method: 'card' | 'ach' = 'card') {
  const out = await createPublicCheckout(w.tdb.app.db, deps, token, amount ? { method, amount } : { method }, { successUrl: 'https://evenbooks.test/i/x?checkout=success', cancelUrl: 'https://evenbooks.test/i/x?checkout=cancel' });
  const sessionId = out.url.split('/').pop()!;
  return { ...out, sessionId };
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Globex', isCustomer: true, isVendor: false, email: 'ap@globex.test' }))).id;
  checkingId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Main Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! }))).id;
});
afterAll(() => w.destroy());

describe('processor connection', () => {
  it('connects, creates system accounts, becomes active after onboarding', async () => {
    const res = await w.run(w.ctxA, (s) => connectProcessor(s, deps, { returnUrl: 'https://evenbooks.test/settings/payments?return=1', refreshUrl: 'https://evenbooks.test/settings/payments?refresh=1' }));
    expect(res.onboardingUrl).toContain('/pay/fixture/onboard');
    expect(res.connection.status).toBe('pending');
    expect(res.connection.platformFee).toEqual({ plan: 'free', cardTotalPercent: '5', achTotalPercent: '1' });
    accountId = res.connection.providerAccountId;
    const accounts = await w.run(w.ctxA, (s) => listAccounts(s));
    expect(accounts.find((a) => a.role === 'processor_clearing')?.name).toBe('Stripe balance');
    expect(accounts.find((a) => a.role === 'processor_fees')?.name).toBe('Merchant processing fees');

    // connecting again resumes rather than duplicating
    const again = await w.run(w.ctxA, (s) => connectProcessor(s, deps, { returnUrl: 'https://evenbooks.test/r', refreshUrl: 'https://evenbooks.test/f' }));
    expect(again.connection.id).toBe(res.connection.id);

    await ingestAll([client.completeOnboarding(accountId)]);
    const conn = (await w.run(w.ctxA, (s) => getProcessorConnection(s, deps)))!;
    expect(conn.status).toBe('active');
    expect(conn.chargesEnabled).toBe(true);
    const refreshed = await w.run(w.ctxA, (s) => refreshProcessorConnection(s, deps));
    expect(refreshed.status).toBe('active');
    await w.run(w.ctxA, (s) => updateProcessorConnection(s, deps, { version: refreshed.version, payoutBankAccountId: checkingId }));
  });

  it('is invisible to the other company', async () => {
    expect(await w.run(w.ctxB, (s) => getProcessorConnection(s, deps))).toBeNull();
    expect(await w.run(w.ctxB, (s) => listProcessorCharges(s, { limit: 50 }))).toEqual([]);
  });
});

describe('card payment through checkout', () => {
  it('records the payment, allocates it, posts the fees, and the public page reflects it', async () => {
    const { inv, token } = await issuedInvoice('1000.00');
    const pub = (await getPublicInvoice(w.tdb.app.db, token))!.dto;
    expect(pub.onlinePayment).toEqual({ methods: ['card', 'ach'], allowPartial: true, minimumPayment: '1.00', payableAmount: '1000.00', processingAmount: '0.00' });

    const co = await checkout(token);
    const before = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(before.status).toBe('pending');
    expect(before.platformFee).toBe('20.70'); // 5% all-in = 50.00 minus Stripe's 29.30

    const outcomes = await ingestAll(client.completeCheckout(co.sessionId, { method: 'card', payerEmail: 'ap@globex.test' }));
    expect(outcomes.map((o) => o.status)).toEqual(['processed', 'processed']);

    const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(charge.status).toBe('succeeded');
    expect(charge.method).toBe('card');
    expect(charge.processorFee).toBe('29.30'); // 2.9% + 0.30
    expect(charge.platformFee).toBe('20.70');
    expect(charge.paymentId).not.toBeNull();
    expect(charge.feeJournalEntryId).not.toBeNull();

    const payment = await w.run(w.ctxA, (s) => getPayment(s, charge.paymentId!));
    expect(payment.amount).toBe('1000.00');
    expect(payment.amountAllocated).toBe('1000.00');
    expect(payment.method).toBe('card');
    expect(payment.reference).toBe(charge.providerPaymentIntentId);
    expect(payment.processorChargeId).toBe(charge.id);

    const paid = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(paid.status).toBe('paid');
    expect(paid.balanceDue).toBe('0.00');

    // clearing = gross - fees; the business paid exactly 5 percent all in
    expect(await balanceOfRole('processor_clearing')).toBe('950.000000');
    expect(await balanceOfRole('processor_fees')).toBe('50.000000');

    const pubAfter = (await getPublicInvoice(w.tdb.app.db, token))!.dto;
    expect(pubAfter.status).toBe('paid');
    expect(pubAfter.onlinePayment).toBeNull();

    // the online payment cannot be voided by hand
    await expect(w.run(w.ctxA, (s) => voidPayment(s, payment.id, { version: payment.version, reason: 'oops' }))).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('is idempotent under duplicate and replayed events', async () => {
    const { token } = await issuedInvoice('200.00');
    const co = await checkout(token);
    const events = client.completeCheckout(co.sessionId, { method: 'card' });
    await ingestAll(events);
    const dup = await ingestAll(events);
    expect(dup.map((o) => o.status)).toEqual(['duplicate', 'duplicate']);
    // a re-sent event under a new id (Stripe resend) is harmless too
    const resend = { ...events[1]!, id: events[1]!.id + '_resend', raw: { ...events[1]!.raw, id: events[1]!.id + '_resend' } };
    expect((await ingestAll([resend]))[0]!.status).toBe('processed');
    const charges = await w.run(w.ctxA, (s) => listProcessorCharges(s, { limit: 200 }));
    expect(charges.filter((c) => c.id === co.chargeId)).toHaveLength(1);
    const n = await w.run(w.ctxA, (s) => s.tx.execute<{ n: string }>(sql`select count(*)::text as n from payments where company_id = ${s.ctx.companyId} and reference = ${charges.find((c) => c.id === co.chargeId)!.providerPaymentIntentId}`));
    expect(n.rows[0]!.n).toBe('1');
  });
});

describe('fees that Stripe attaches after the charge succeeds', () => {
  it('posts the payment at once and the fees when charge.updated arrives', async () => {
    client.deferBalanceTransactions = true;
    try {
      const clearingBefore = Number(await balanceOfRole('processor_clearing'));
      const feesBefore = Number(await balanceOfRole('processor_fees'));
      const { inv, token } = await issuedInvoice('300.00');
      const co = await checkout(token);
      expect((await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }))).map((o) => o.status)).toEqual(['processed', 'processed']);

      const early = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
      expect(early.status).toBe('succeeded');
      expect(early.paymentId).not.toBeNull();
      expect(early.feeJournalEntryId).toBeNull();
      expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).status).toBe('paid');
      expect(Number(await balanceOfRole('processor_clearing')) - clearingBefore).toBeCloseTo(300, 6);

      // a refund waits until the fees are known
      await expect(refundProcessorCharge(w.tdb.app.db, deps, w.ctxA, early.id, { version: early.version, amount: '10.00', reason: 'too early' })).rejects.toMatchObject({ code: 'invalid_state' });

      const piId = early.providerPaymentIntentId!;
      expect((await ingestAll(client.attachBalanceTransaction(piId))).map((o) => o.status)).toEqual(['processed']);
      const settled = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
      expect(settled.processorFee).toBe('9.00'); // 2.9% + 0.30
      expect(settled.platformFee).toBe('6.00'); // 5% all-in minus Stripe's fee
      expect(settled.feeJournalEntryId).not.toBeNull();
      expect(Number(await balanceOfRole('processor_clearing')) - clearingBefore).toBeCloseTo(285, 6);
      expect(Number(await balanceOfRole('processor_fees')) - feesBefore).toBeCloseTo(15, 6);

      // a replayed charge.updated changes nothing
      await ingestAll(client.events.filter((e) => e.type === 'charge.updated').slice(-1).map((e) => ({ ...e, id: e.id + '_replay' })));
      expect(Number(await balanceOfRole('processor_fees')) - feesBefore).toBeCloseTo(15, 6);
    } finally {
      client.deferBalanceTransactions = false;
    }
  });

  it('the worker sweep posts fees whose charge.updated never arrived', async () => {
    client.deferBalanceTransactions = true;
    try {
      const feesBefore = Number(await balanceOfRole('processor_fees'));
      const { token } = await issuedInvoice('100.00');
      const co = await checkout(token);
      await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }));
      const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));

      // not attached yet: the sweep leaves it alone and reports nothing settled
      expect((await settlePendingChargeFees(w.tdb.app.db, deps, { olderThanMs: 0 })).settled).toBe(0);

      client.attachBalanceTransaction(charge.providerPaymentIntentId!); // event dropped on purpose
      expect((await settlePendingChargeFees(w.tdb.app.db, deps, { olderThanMs: 0 })).settled).toBe(1);
      const after = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
      expect(after.processorFee).toBe('3.20');
      expect(after.platformFee).toBe('1.80');
      expect(Number(await balanceOfRole('processor_fees')) - feesBefore).toBeCloseTo(5, 6);
      expect((await settlePendingChargeFees(w.tdb.app.db, deps, { olderThanMs: 0 })).checked).toBe(0);
    } finally {
      client.deferBalanceTransactions = false;
    }
  });
});

describe('partial payments and ACH', () => {
  it('takes a partial card payment, then the rest by ACH which settles later', async () => {
    const { inv, token } = await issuedInvoice('600.00');
    await expect(checkout(token, '0.50')).rejects.toMatchObject({ code: 'validation' }); // below minimum
    await expect(checkout(token, '700.00')).rejects.toMatchObject({ code: 'validation' }); // above balance

    const first = await checkout(token, '250.00');
    await ingestAll(client.completeCheckout(first.sessionId, { method: 'card' }));
    let cur = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(cur.balanceDue).toBe('350.00');
    expect(cur.status).toBe('issued');

    const second = await checkout(token, undefined, 'ach'); // defaults to the payable remainder
    const accepted = await ingestAll(client.completeCheckout(second.sessionId, { method: 'ach' }));
    expect(accepted.map((o) => o.status)).toEqual(['processed']);
    let charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, second.chargeId));
    expect(charge.status).toBe('processing');
    expect(charge.amount).toBe('350.00');
    // while the debit is in flight the invoice is still open in the books but not payable again online
    const pub = (await getPublicInvoice(w.tdb.app.db, token))!.dto;
    expect(pub.balanceDue).toBe('350.00');
    expect(pub.onlinePayment?.payableAmount).toBe('0.00');
    expect(pub.onlinePayment?.processingAmount).toBe('350.00');
    await expect(checkout(token)).rejects.toMatchObject({ code: 'invalid_state' });

    await ingestAll(client.settleAch(second.sessionId, 'succeeded'));
    charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, second.chargeId));
    expect(charge.status).toBe('succeeded');
    expect(charge.method).toBe('ach');
    expect(charge.processorFee).toBe('2.80'); // 0.8% of 350
    expect(charge.platformFee).toBe('0.70'); // 1% all-in = 3.50 minus Stripe's 2.80
    cur = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(cur.status).toBe('paid');
  });

  it('a failed ACH debit reopens the pay button and records nothing', async () => {
    const { inv, token } = await issuedInvoice('100.00');
    const co = await checkout(token, undefined, 'ach');
    await ingestAll(client.completeCheckout(co.sessionId, { method: 'ach' }));
    await ingestAll(client.settleAch(co.sessionId, 'failed'));
    const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(charge.status).toBe('failed');
    expect(charge.paymentId).toBeNull();
    const cur = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(cur.balanceDue).toBe('100.00');
    const pub = (await getPublicInvoice(w.tdb.app.db, token))!.dto;
    expect(pub.onlinePayment?.payableAmount).toBe('100.00');
  });

  it('a manual payment recorded while the card payment is in flight leaves the excess unapplied', async () => {
    const { inv, token } = await issuedInvoice('300.00');
    const co = await checkout(token);
    await w.run(w.ctxA, (s) => createPayment(s, { contactId: customerId, date: '2026-09-02', amount: '300.00', method: 'check', depositAccountId: acct.get('1000')!, isRefundableDeposit: false, allocations: [{ invoiceId: inv.id, amount: '300.00' }] }));
    await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }));
    const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    const payment = await w.run(w.ctxA, (s) => getPayment(s, charge.paymentId!));
    expect(payment.amountAllocated).toBe('0.00');
    expect(payment.unappliedAmount).toBe('300.00');
    expect(payment.contactId).toBe(customerId);
  });
});

describe('external charges', () => {
  it('a charge made in the Stripe dashboard lands as unapplied customer funds', async () => {
    const evt = client.externalCharge(accountId, '80.00', 'USD', { description: 'Payment link: sticker pack', payerEmail: 'someone@example.test' });
    const [out] = await ingestAll([evt]);
    expect(out!.status).toBe('processed');
    const charges = await w.run(w.ctxA, (s) => listProcessorCharges(s, { limit: 200 }));
    const ext = charges.find((c) => c.origin === 'external')!;
    expect(ext.status).toBe('succeeded');
    expect(ext.invoiceId).toBeNull();
    const payment = await w.run(w.ctxA, (s) => getPayment(s, ext.paymentId!));
    expect(payment.unappliedAmount).toBe('80.00');
    expect(payment.contactId).toBeNull();
    expect(payment.memo).toContain('sticker pack');
  });

  it('events for unknown accounts are stored and ignored, malformed handling is retried by the worker', async () => {
    const stray = client.emit('payment_intent.succeeded', 'acct_unknown', { id: 'pi_nope', object: 'payment_intent', status: 'succeeded' });
    expect((await ingestAll([stray]))[0]!.status).toBe('ignored');
    // an event whose intent the provider does not know fails and is visible on the jobs page
    const bad = client.emit('payment_intent.succeeded', accountId, { id: 'pi_missing', object: 'payment_intent', status: 'succeeded', metadata: {} });
    const [out] = await ingestAll([bad]);
    expect(out!.status).toBe('failed');
    const status = await w.run(w.ctxA, (s) => jobStatus(s));
    expect(status.processorEventProblems.some((p) => p.eventType === 'payment_intent.succeeded' && p.lastError)).toBe(true);
    const retried = await retryProcessorEvents(w.tdb.app.db, deps, { olderThanMs: 0 });
    expect(retried.retried).toBeGreaterThanOrEqual(1);
    expect(retried.processed).toBe(0);
  });
});

describe('metadata compatibility after the rename', () => {
  it('matches a checkout using its original metadata when the payment-intent ID was not saved', async () => {
    const { inv, token } = await issuedInvoice('100.00');
    const co = await checkout(token);
    const events = client.completeCheckout(co.sessionId, { method: 'card' });
    const event = events.find(e => e.type === 'payment_intent.succeeded')!;
    const metadata = event.object.metadata as Record<string, string>;
    expect(metadata.evenbooks_charge_id).toBe(co.chargeId);
    event.object.metadata = { beans_charge_id: metadata.evenbooks_charge_id };
    await w.tdb.admin.pool.query('update processor_charges set provider_payment_intent_id = null where id = $1', [co.chargeId]);

    expect((await ingestAll([event]))[0]!.status).toBe('processed');
    const charge = await w.run(w.ctxA, s => getProcessorCharge(s, co.chargeId));
    expect(charge.status).toBe('succeeded');
    expect(charge.origin).toBe('evenbooks');
    expect((await w.run(w.ctxA, s => getInvoice(s, inv.id))).balanceDue).toBe('0.00');
    const rows = (await w.tdb.admin.pool.query('select id from processor_charges where provider_payment_intent_id = $1', [event.object.id])).rows;
    expect(rows).toEqual([{ id: co.chargeId }]);
  });

  it('finishes a pending refund with original metadata without creating a second refund', async () => {
    const { inv, token } = await issuedInvoice('100.00');
    const co = await checkout(token);
    await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }));
    const charge = await w.run(w.ctxA, s => getProcessorCharge(s, co.chargeId));
    const pendingId = (await w.tdb.admin.pool.query<{ id: string }>(`
      insert into processor_refunds (company_id, charge_id, provider, kind, origin, amount, requested_by)
      select company_id, id, provider, 'refund', 'evenbooks', 25, 'user_a'
      from processor_charges where id = $1 returning id`, [charge.id])).rows[0]!.id;
    await client.createRefund({
      accountId, paymentIntentId: charge.providerPaymentIntentId!, amount: '25.00',
      currency: 'USD', applicationFeeRefund: '0', idempotencyKey: pendingId,
      metadata: { beans_refund_id: pendingId, beans_charge_id: charge.id },
    });
    const event = client.events.at(-1)!;
    expect((await ingestAll([event]))[0]!.status).toBe('processed');
    const after = await w.run(w.ctxA, s => getProcessorCharge(s, charge.id));
    expect(after.refunds).toHaveLength(1);
    expect(after.refunds[0]).toMatchObject({ id: pendingId, status: 'succeeded', origin: 'evenbooks' });
    expect(after.amountRefunded).toBe('25.00');
    expect((await w.run(w.ctxA, s => getInvoice(s, inv.id))).balanceDue).toBe('25.00');
    expect((await ingestAll([event]))[0]!.status).toBe('duplicate');
  });
});

describe('refunds and disputes', () => {
  it('refunds part of an applied payment from Evenbooks: invoice reopens for that part, clearing drops, platform fee refunded proportionally', async () => {
    const { inv, token } = await issuedInvoice('400.00');
    const co = await checkout(token);
    await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }));
    const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    const clearingBefore = await balanceOfRole('processor_clearing');
    const feesBefore = await balanceOfRole('processor_fees');

    const refund = await refundProcessorCharge(w.tdb.app.db, deps, w.ctxA, charge.id, { version: charge.version, amount: '100.00', reason: 'Scope reduced' });
    expect(refund.status).toBe('succeeded');
    expect(refund.origin).toBe('evenbooks');
    expect(refund.platformFeeRefunded).toBe('2.03'); // 8.10 fee * 100/400 = 2.025, half up
    expect(refund.refundId).not.toBeNull();

    const after = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(after.amountRefunded).toBe('100.00');
    expect(after.refundableAmount).toBe('300.00');
    expect(after.refunds).toHaveLength(1);
    const invAfter = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(invAfter.status).toBe('issued');
    expect(invAfter.balanceDue).toBe('100.00'); // only the refunded part reopened
    const payment = await w.run(w.ctxA, (s) => getPayment(s, charge.paymentId!));
    expect(payment.amountAllocated).toBe('300.00');
    expect(payment.amountRefunded).toBe('100.00');
    expect(payment.unappliedAmount).toBe('0.00');
    // the refund leaves clearing, our returned share comes back into it
    expect(Number(await balanceOfRole('processor_clearing'))).toBeCloseTo(Number(clearingBefore) - 100 + 2.03, 6);
    expect(Number(await balanceOfRole('processor_fees'))).toBeCloseTo(Number(feesBefore) - 2.03, 6);

    // the provider's own charge.refunded event for this refund is a no-op
    const evts = client.events.filter((e) => e.type === 'charge.refunded');
    const outs = await ingestAll([evts[evts.length - 1]!]);
    expect(['duplicate', 'processed']).toContain(outs[0]!.status);
    expect((await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId))).amountRefunded).toBe('100.00');

    await expect(refundProcessorCharge(w.tdb.app.db, deps, w.ctxA, charge.id, { version: after.version, amount: '350.00', reason: 'too much' })).rejects.toMatchObject({ code: 'over_allocation' });
  });

  it('a refund issued from the Stripe dashboard posts the same way', async () => {
    const { inv, token } = await issuedInvoice('150.00');
    const co = await checkout(token);
    await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }));
    const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    await ingestAll([client.externalRefund(accountId, charge.providerPaymentIntentId!, '150.00')]);
    const after = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(after.amountRefunded).toBe('150.00');
    expect(after.refunds[0]!.origin).toBe('external');
    const invAfter = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(invAfter.balanceDue).toBe('150.00');
    expect(invAfter.status).toBe('issued');
  });

  it('a dispute withdraws the funds plus a fee; winning it puts both back', async () => {
    const { inv, token } = await issuedInvoice('500.00');
    const co = await checkout(token);
    await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }));
    const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    const clearingBefore = Number(await balanceOfRole('processor_clearing'));
    const feesBefore = Number(await balanceOfRole('processor_fees'));

    const opened = client.openDispute(accountId, charge.providerPaymentIntentId!, { fee: '15.00', reason: 'product_not_received' });
    await ingestAll([opened]);
    let after = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(after.amountDisputed).toBe('500.00');
    expect(after.refundableAmount).toBe('0.00');
    expect(after.refunds.find((r) => r.kind === 'dispute')?.feeAmount).toBe('15.00');
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).balanceDue).toBe('500.00');
    expect(Number(await balanceOfRole('processor_clearing'))).toBeCloseTo(clearingBefore - 515, 6);
    expect(Number(await balanceOfRole('processor_fees'))).toBeCloseTo(feesBefore + 15, 6);

    const disputeId = (opened.object as { id: string }).id;
    await ingestAll([client.closeDispute(disputeId, 'won')]);
    after = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(after.amountDisputed).toBe('0.00');
    expect(after.refunds.find((r) => r.kind === 'dispute_reversal')?.status).toBe('succeeded');
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).status).toBe('paid');
    expect(Number(await balanceOfRole('processor_clearing'))).toBeCloseTo(clearingBefore, 6);
    expect(Number(await balanceOfRole('processor_fees'))).toBeCloseTo(feesBefore, 6);
  });
});

describe('payouts', () => {
  it('posts the payout transfer, the bank line matches it, and clearing returns to zero after a full payout', async () => {
    const clearing = Number(await balanceOfRole('processor_clearing'));
    expect(clearing).toBeGreaterThan(0);
    const amount = clearing.toFixed(2);
    const checkingBefore = Number(await balance(w.ctxA, '1000'));

    await ingestAll([client.payout(accountId, amount, 'USD', '2026-09-10')]);
    const payouts = await w.run(w.ctxA, (s) => listProcessorPayouts(s));
    expect(payouts[0]!.status).toBe('paid');
    expect(payouts[0]!.journalEntryId).not.toBeNull();
    expect(payouts[0]!.bankAccountName).toBe('Main Checking');
    expect(Number(await balanceOfRole('processor_clearing'))).toBeCloseTo(0, 6);
    expect(Number(await balance(w.ctxA, '1000'))).toBeCloseTo(checkingBefore + clearing, 6);

    // the bank feed line arrives and matches the posted payout with no new posting
    const line = await w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId: checkingId, date: '2026-09-11', amount, description: 'STRIPE TRANSFER' }));
    const cands = await w.run(w.ctxA, (s) => matchCandidates(s, line.id));
    const payoutCand = cands.find((c) => c.targetType === 'processor_payout');
    expect(payoutCand?.targetId).toBe(payouts[0]!.id);
    const matched = await w.run(w.ctxA, (s) => matchTransaction(s, line.id, { version: line.version, targets: [{ targetType: 'processor_payout', targetId: payouts[0]!.id }] }));
    expect(matched.status).toBe('matched');
    expect(Number(await balance(w.ctxA, '1000'))).toBeCloseTo(checkingBefore + clearing, 6);
  });

  it('a failed payout is reversed', async () => {
    const evt = client.payout(accountId, '10.00', 'USD', '2026-09-12');
    await ingestAll([evt]);
    const before = Number(await balance(w.ctxA, '1000'));
    const payoutId = (evt.object as { id: string }).id;
    await ingestAll([client.failPayout(payoutId)]);
    const payouts = await w.run(w.ctxA, (s) => listProcessorPayouts(s));
    const p = payouts.find((x) => x.providerPayoutId === payoutId)!;
    expect(p.status).toBe('failed');
    expect(p.reversalEntryId).not.toBeNull();
    expect(Number(await balance(w.ctxA, '1000'))).toBeCloseTo(before - 10, 6);
  });
});

describe('invoice emails', () => {
  it('tell the customer they can pay online by card or bank debit when Stripe is connected', async () => {
    const { inv } = await issuedInvoice('120.00');
    const queued = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, inv.id, { to: 'ap@globex.test' }, { baseUrl: 'https://evenbooks.test' }));
    const sender = new LogEmailSender();
    const storage = new LocalStorage(await mkdtemp(path.join(os.tmpdir(), 'evenbooks-proc-email-')));
    await sendQueuedEmail({ db: w.tdb.app.db, storage, sender, config: { from: 'Evenbooks <billing@test>', replyTo: null, configurationSet: null }, baseUrl: 'https://evenbooks.test' }, queued.id, null);
    expect(sender.sent).toHaveLength(1);
    const text = sender.sent[0]!.text ?? '';
    expect(text).toContain('Pay online by card or bank debit: https://evenbooks.test/i/');
    expect(sender.sent[0]!.html ?? '').toContain('Pay online');
  });
});

describe('books stay consistent', () => {
  it('cash recognition re-derives exactly and cash P&L includes the fees', async () => {
    const verify = await w.run(w.ctxA, (s) => verifyCashRecognition(s));
    expect(verify.ok).toBe(true);
    const cash = await w.run(w.ctxA, (s) => profitAndLoss(s, { from: '2026-01-01', to: '2026-12-31', basis: 'cash' }));
    const fees = cash.expenses.find((l) => l.name === 'Merchant processing fees');
    expect(fees).toBeTruthy();
    expect(Number(fees!.amount)).toBeGreaterThan(0);
  });

  it('a method the company does not offer is refused', async () => {
    const conn = (await w.run(w.ctxA, (s) => getProcessorConnection(s, deps)))!;
    await w.run(w.ctxA, (s) => updateProcessorConnection(s, deps, { version: conn.version, allowAch: false }));
    const { token } = await issuedInvoice('50.00');
    await expect(checkout(token, undefined, 'ach')).rejects.toMatchObject({ code: 'validation' });
    const again = (await w.run(w.ctxA, (s) => getProcessorConnection(s, deps)))!;
    await w.run(w.ctxA, (s) => updateProcessorConnection(s, deps, { version: again.version, allowAch: true }));
  });

  it('the paid plan pays no platform fee', async () => {
    await w.run(w.ctxA, (s) => s.tx.execute(sql`update companies set plan = 'paid' where id = ${s.ctx.companyId}`));
    const { token } = await issuedInvoice('1000.00');
    const co = await checkout(token);
    const charge = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(charge.platformFee).toBe('0.00');
    await ingestAll(client.completeCheckout(co.sessionId, { method: 'card' }));
    const settled = await w.run(w.ctxA, (s) => getProcessorCharge(s, co.chargeId));
    expect(settled.platformFee).toBe('0.00');
    expect(settled.processorFee).toBe('29.30');
  });
});


describe('linking an existing Stripe account', () => {
  const redirectUri = 'https://evenbooks.test/api/processor/connection/link/callback';
  let linkedAccount: string;
  let linkedConnectionId: string;

  it('replaces an unfinished created account with the linked one and records its prior balance', async () => {
    const created = await w.run(w.ctxB, (s) => connectProcessor(s, deps, { returnUrl: 'https://evenbooks.test/r', refreshUrl: 'https://evenbooks.test/f' }));
    expect(created.connection.origin).toBe('created');
    const start = await w.run(w.ctxB, (s) => startProcessorLink(s, deps, { state: 'nonce-1', redirectUri }));
    expect(start.url).toContain('/pay/fixture/link');
    expect(start.url).toContain('state=nonce-1');

    const { code, accountId: acctId } = client.authorizeLink({ balance: '250.00', displayName: 'Initech LLC' });
    linkedAccount = acctId;
    const linked = await w.run(w.ctxB, (s) => linkProcessorAccount(s, deps, { code }));
    linkedConnectionId = linked.id;
    expect(linked).toMatchObject({ origin: 'linked', status: 'active', chargesEnabled: true, providerAccountId: acctId, displayName: 'Initech LLC', linkedBalance: '250.00' });
    expect(linked.linkedAt).toBeTruthy();
    expect(linked.clearingAccountId).toBe(created.connection.clearingAccountId);

    const rows = await w.run(w.ctxB, (s) => s.tx.execute<{ provider_account_id: string; status: string }>(sql`select provider_account_id, status from payment_processor_connections where company_id = ${s.ctx.companyId} order by created_at`));
    expect(rows.rows).toEqual([
      { provider_account_id: created.connection.providerAccountId, status: 'disconnected' },
      { provider_account_id: acctId, status: 'active' },
    ]);
    // the code is single use
    await expect(w.run(w.ctxB, (s) => linkProcessorAccount(s, deps, { code }))).rejects.toMatchObject({ kind: 'invalid_request' });
  });

  it('refuses to replace an account that is in use', async () => {
    await expect(w.run(w.ctxA, (s) => startProcessorLink(s, deps, { state: 'n', redirectUri }))).rejects.toMatchObject({ code: 'invalid_state' });
    const { code } = client.authorizeLink();
    await expect(w.run(w.ctxA, (s) => linkProcessorAccount(s, deps, { code }))).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('refuses an account another company uses, or one in another currency', async () => {
    const conn = (await w.run(w.ctxA, (s) => getProcessorConnection(s, deps)))!;
    await w.run(w.ctxA, (s) => disconnectProcessor(s, deps, { version: conn.version }));
    const taken = client.authorizeLink({ accountId: linkedAccount });
    await expect(w.run(w.ctxA, (s) => linkProcessorAccount(s, deps, { code: taken.code }))).rejects.toMatchObject({ code: 'conflict' });
    const euro = client.authorizeLink({ currency: 'EUR' });
    await expect(w.run(w.ctxA, (s) => linkProcessorAccount(s, deps, { code: euro.code }))).rejects.toMatchObject({ code: 'validation' });
    expect(await w.run(w.ctxA, (s) => getProcessorConnection(s, deps))).toBeNull();
  });

  it('relinking a previously connected account reactivates its connection', async () => {
    const again = client.authorizeLink({ accountId });
    const conn = await w.run(w.ctxA, (s) => linkProcessorAccount(s, deps, { code: again.code }));
    expect(conn).toMatchObject({ providerAccountId: accountId, status: 'active', origin: 'created', linkedBalance: null });
  });

  it('marks the connection disconnected when the business removes Evenbooks in Stripe', async () => {
    const out = await ingestAll([client.deauthorize(linkedAccount)]);
    expect(out[0]!.status).toBe('processed');
    expect(await w.run(w.ctxB, (s) => getProcessorConnection(s, deps))).toBeNull();
    const again = client.authorizeLink({ accountId: linkedAccount });
    const conn = await w.run(w.ctxB, (s) => linkProcessorAccount(s, deps, { code: again.code }));
    expect(conn).toMatchObject({ id: linkedConnectionId, status: 'active', origin: 'linked', lastError: null });
  });
});
