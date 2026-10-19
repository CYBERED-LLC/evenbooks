import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InvoiceDto } from '@evenbooks/contracts';
import { bulkInvoiceAction, bulkUpdateContacts, createContact, createDraftInvoice, getContact, getInvoice, issueInvoice, listInvoiceEmails, updateContact, voidInvoice } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let withEmail: string;
let noEmail: string;
let later: string;

const key = (s: string) => `bulk-test-${s}-xxxxxxxx`;

async function draft(contactId: string, price = '100'): Promise<InvoiceDto> {
  return w.run(w.ctxA, (s) =>
    createDraftInvoice(s, { contactId, issueDate: '2026-05-01', lines: [{ description: 'Work', quantity: '1', unitPrice: price, incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }),
  );
}

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  withEmail = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Has Email', isCustomer: true, isVendor: false, email: 'ap@has-email.test' }))).id;
  noEmail = (await w.run(w.ctxA, (s) => createContact(s, { name: 'No Email', isCustomer: true, isVendor: false }))).id;
  later = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Email Added Later', isCustomer: true, isVendor: false }))).id;
});
afterAll(async () => {
  await w.destroy();
});

describe('bulk issue', () => {
  it('issues each draft on its own, reports failures per item, and replays on retry', async () => {
    const a = await draft(withEmail);
    const b = await draft(withEmail);
    const zero = await draft(withEmail, '0');
    const stale = await draft(withEmail);
    const items = [
      { id: a.id, version: a.version, idempotencyKey: key('a') },
      { id: zero.id, version: zero.version, idempotencyKey: key('zero') },
      { id: b.id, version: b.version, idempotencyKey: key('b') },
      { id: stale.id, version: stale.version + 7, idempotencyKey: key('stale') },
      { id: a.id, version: a.version, idempotencyKey: key('a2') },
    ];
    const res = await w.run(w.ctxA, (s) => bulkInvoiceAction(s, { action: 'issue', items }));
    expect(res).toMatchObject({ action: 'issue', succeeded: 2, failed: 3, skipped: 0 });
    const by = new Map(res.results.map((r, i) => [`${r.id}:${i}`, r]));
    expect(by.get(`${a.id}:0`)).toMatchObject({ ok: true, invoice: { status: 'issued' } });
    expect(by.get(`${zero.id}:1`)).toMatchObject({ ok: false, error: { code: 'validation' } });
    expect(by.get(`${b.id}:2`)?.ok).toBe(true);
    expect(by.get(`${stale.id}:3`)).toMatchObject({ ok: false, error: { code: 'version_conflict' } });
    expect(by.get(`${a.id}:4`)).toMatchObject({ ok: false, error: { code: 'duplicate' } });
    const numberA = res.results[0]!.number;
    expect(numberA).toMatch(/\d{4}$/);

    // The failures rolled back alone: the stale draft is still a draft.
    expect((await w.run(w.ctxA, (s) => getInvoice(s, stale.id))).status).toBe('draft');

    // Same keys again (a retry after a lost response): no second number, no second posting.
    const again = await w.run(w.ctxA, (s) => bulkInvoiceAction(s, { action: 'issue', items: items.slice(0, 3) }));
    expect(again.results[0]).toMatchObject({ ok: true, number: numberA });
    expect(again.results[2]).toMatchObject({ ok: true, number: res.results[2]!.number });
  });
});

describe('bulk send', () => {
  it('queues emails for issued invoices, skips ones without an address, and fails drafts and voids', async () => {
    const issue = async (contactId: string) => {
      const d = await draft(contactId);
      return w.run(w.ctxA, (s) => issueInvoice(s, d.id, { version: d.version }));
    };
    const ok = await issue(withEmail);
    const missing = await issue(noEmail);
    const fallback = await issue(later);
    // The contact gains an email after issue: the invoice snapshot has none, the contact does.
    const laterContact = await w.run(w.ctxA, (s) => getContact(s, later));
    await w.run(w.ctxA, (s) => updateContact(s, later, { version: laterContact.version, email: 'billing@later.test' }));
    const stillDraft = await draft(withEmail);
    const voided = await issue(withEmail);
    await w.run(w.ctxA, (s) => voidInvoice(s, voided.id, { version: voided.version, reason: 'test' }));

    const items = [ok, missing, fallback, stillDraft, voided].map((i, n) => ({ id: i.id, version: i.version, idempotencyKey: key(`send-${n}`) }));
    const res = await w.run(w.ctxA, (s) => bulkInvoiceAction(s, { action: 'send', items, message: 'Thanks!' }));
    expect(res).toMatchObject({ action: 'send', succeeded: 2, skipped: 1, failed: 2 });
    expect(res.results[0]).toMatchObject({ ok: true, number: ok.number, email: { toEmail: 'ap@has-email.test', status: 'queued', isResend: false } });
    expect(res.results[1]).toMatchObject({ ok: false, skipped: true, error: { code: 'no_email' } });
    expect(res.results[2]).toMatchObject({ ok: true, email: { toEmail: 'billing@later.test' } });
    expect(res.results[3]).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
    expect(res.results[4]).toMatchObject({ ok: false, error: { code: 'invalid_state' } });

    // A retry with the same keys returns the same messages instead of queuing copies.
    const again = await w.run(w.ctxA, (s) => bulkInvoiceAction(s, { action: 'send', items: items.slice(0, 1), message: 'Thanks!' }));
    expect(again.results[0]!.email!.id).toBe(res.results[0]!.email!.id);
    expect(await w.run(w.ctxA, (s) => listInvoiceEmails(s, ok.id))).toHaveLength(1);

    // A new request (fresh key) is a resend.
    const resend = await w.run(w.ctxA, (s) => bulkInvoiceAction(s, { action: 'send', items: [{ ...items[0]!, idempotencyKey: key('send-again') }] }));
    expect(resend.results[0]).toMatchObject({ ok: true, email: { isResend: true } });
    expect(await w.run(w.ctxA, (s) => listInvoiceEmails(s, ok.id))).toHaveLength(2);
  });
});

describe('bulk archive contacts', () => {
  it('archives per contact, reports stale versions, and restores with the returned versions', async () => {
    const make = (name: string) => w.run(w.ctxA, (s) => createContact(s, { name, isCustomer: true, isVendor: false }));
    const one = await make('Bulk One');
    const two = await make('Bulk Two');
    const res = await w.run(w.ctxA, (s) =>
      bulkUpdateContacts(s, {
        action: 'archive',
        items: [
          { id: one.id, version: one.version },
          { id: two.id, version: two.version + 3 },
        ],
      }),
    );
    expect(res).toMatchObject({ succeeded: 1, failed: 1 });
    expect(res.results[0]).toMatchObject({ ok: true, contact: { isArchived: true } });
    expect(res.results[1]).toMatchObject({ ok: false, error: { code: 'version_conflict' } });

    const undo = await w.run(w.ctxA, (s) => bulkUpdateContacts(s, { action: 'unarchive', items: [{ id: one.id, version: res.results[0]!.contact!.version }] }));
    expect(undo.results[0]).toMatchObject({ ok: true, contact: { isArchived: false } });
  });
});
