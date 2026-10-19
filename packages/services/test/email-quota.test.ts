import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMAIL_QUOTAS, ServiceError, createContact, createDraftInvoice, issueInvoice, queueInvoiceEmail } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let invoiceId: string;

beforeAll(async () => {
  w = await createWorld();
  const acct = await w.accountsByCode(w.ctxA);
  const customer = await w.run(w.ctxA, (s) => createContact(s, { name: 'Quota Client', isCustomer: true, isVendor: false, email: 'ap@quota.test' }));
  const draft = await w.run(w.ctxA, (s) =>
    createDraftInvoice(s, { contactId: customer.id, issueDate: '2026-05-01', lines: [{ description: 'Consulting', quantity: '1', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }),
  );
  invoiceId = (await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }))).id;
});
afterAll(async () => {
  await w.destroy();
});

describe('invoice email quota', () => {
  it('stops a free-plan company after its hourly allowance, with a 429, and keeps other companies unaffected', async () => {
    const { perHour } = EMAIL_QUOTAS.free;
    for (let i = 0; i < perHour; i++) {
      await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoiceId, { to: `r${i}@example.test`, idempotencyKey: `quota-${i}`.padEnd(8, 'x') }));
    }
    const err = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoiceId, { to: 'one-too-many@example.test', idempotencyKey: 'quota-over' })).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('rate_limited');
    expect((err as ServiceError).status).toBe(429);

    // Automatic sends (recurring invoices) are not blocked.
    const auto = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, invoiceId, { to: 'ap@quota.test', auto: true }));
    expect(auto.status).toBe('queued');

    // A different company starts from zero.
    const acctB = await w.accountsByCode(w.ctxB);
    const customerB = await w.run(w.ctxB, (s) => createContact(s, { name: 'Other Client', isCustomer: true, isVendor: false, email: 'ap@other.test' }));
    const draftB = await w.run(w.ctxB, (s) =>
      createDraftInvoice(s, { contactId: customerB.id, issueDate: '2026-05-01', lines: [{ description: 'Consulting', quantity: '1', unitPrice: '50', incomeAccountId: acctB.get('4100')!, taxRateIds: [] }] }),
    );
    const issuedB = await w.run(w.ctxB, (s) => issueInvoice(s, draftB.id, { version: draftB.version }));
    const ok = await w.run(w.ctxB, (s) => queueInvoiceEmail(s, issuedB.id, { to: 'ap@other.test', idempotencyKey: 'quota-b-1' }));
    expect(ok.status).toBe('queued');
  });
});
