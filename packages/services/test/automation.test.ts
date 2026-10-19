import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withCompany } from '@evenbooks/db';
import { FixtureSimpleFinClient, SimpleFinError } from '@evenbooks/integrations';
import {
  cancelSchedule,
  connectSimpleFin,
  createContact,
  createDraftInvoice,
  createSchedule,
  discoverAccounts,
  disconnect,
  dueConnections,
  dueSchedules,
  getSchedule,
  issueInvoice,
  linkProviderAccounts,
  listInbox,
  listInvoices,
  pauseSchedule,
  reconnectSimpleFin,
  resumeSchedule,
  runScheduleIssuance,
  syncConnection,
  updateCompany,
  updateSchedule,
  categorizeTransaction,
  listConnections,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let customerId: string;

beforeAll(async () => {
  process.env.EVENBOOKS_SYNC_NO_THROTTLE = '1';
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Retainer Client', isCustomer: true, isVendor: false, email: 'billing@client.test' }))).id;
  // company in a US time zone so "today" and run times are deterministic in tests
  await w.run(w.ctxA, (s) => updateCompany(s, { version: s.company.version, timeZone: 'America/Chicago' }));
});
afterAll(async () => {
  await w.destroy();
});

const template = (price: string) => ({ lines: [{ description: 'Monthly retainer', quantity: '1', unitPrice: price, incomeAccountId: acct.get('4100')!, taxRateIds: [] }] });

describe('recurring invoices', () => {
  it('repeat-this-invoice copies contents into a versioned template without copying single-use links', async () => {
    const draft = await w.run(w.ctxA, (s) => createDraftInvoice(s, { contactId: customerId, issueDate: '2026-01-31', paymentUrl: 'https://pay.example/once/abc', lines: template('500').lines }));
    const inv = await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
    const sched = await w.run(w.ctxA, (s) => createSchedule(s, { fromInvoiceId: inv.id, name: 'Retainer', frequency: 'monthly', anchorDate: '2026-02-28', sendEmail: true, copyPaymentUrl: false }));
    expect(sched.template.lines[0]!.unitPrice).toBe('500.000000');
    expect(sched.template.paymentUrl).toBeNull();
    expect(sched.emailTo).toBe('billing@client.test');
    expect(sched.nextOccurrenceDate).toBe('2026-02-28');
    expect(sched.nextRunAt).toBe('2026-02-28T12:00:00.000Z'); // 06:00 Chicago (CST)
    expect(sched.createdFromInvoiceId).toBe(inv.id);
    const updated = await w.run(w.ctxA, (s) => updateSchedule(s, sched.id, { version: sched.version, template: template('550') }));
    expect(updated.templateVersion).toBe(2);
    // the source invoice is untouched
    const again = (await w.run(w.ctxA, (s) => listInvoices(s, { limit: 5, q: inv.number! }))).items[0]!;
    expect(again.total).toBe('500.00');
  });

  it('issues missed occurrences once on restart, with month-end clamping and exactly one invoice per occurrence under concurrency', async () => {
    const sched = await w.run(w.ctxA, (s) => createSchedule(s, { contactId: customerId, name: 'Month-end', frequency: 'monthly', anchorDate: '2026-01-31', template: template('100'), sendEmail: false, copyPaymentUrl: false }));
    // Simulate a worker that comes back on 2026-04-15 having missed Jan 31, Feb 28, Mar 31.
    const now = new Date('2026-04-15T15:00:00Z');
    const [a, b] = await Promise.all([runScheduleIssuance(w.tdb.app.db, w.companyA, sched.id, 'job-a', now), runScheduleIssuance(w.tdb.app.db, w.companyA, sched.id, 'job-b', now)]);
    const issuedTotal = a.issued.length + b.issued.length;
    expect(issuedTotal).toBe(3);
    const detail = await w.run(w.ctxA, (s) => getSchedule(s, sched.id));
    expect(detail.occurrences!.map((o) => o.date).sort()).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(detail.lastIssuedIndex).toBe(2);
    expect(detail.nextOccurrenceDate).toBe('2026-04-30');
    expect(detail.nextRunAt).toBe('2026-04-30T11:00:00.000Z'); // 06:00 Chicago (CDT)
    const numbers = detail.occurrences!.map((o) => o.invoiceNumber);
    expect(new Set(numbers).size).toBe(3);
    // running again issues nothing new
    const again = await runScheduleIssuance(w.tdb.app.db, w.companyA, sched.id, 'job-c', now);
    expect(again.issued).toEqual([]);
    // the database refuses a second invoice for an existing occurrence directly
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) =>
        tx.execute(sql`update invoices set recurring_occurrence_index = 0 where recurring_schedule_id = ${sched.id} and recurring_occurrence_index = 2`),
      ),
    ).rejects.toThrow();
  });

  it('pause, catch-up preview, and resume with skip or catch-up', async () => {
    const sched = await w.run(w.ctxA, (s) => createSchedule(s, { contactId: customerId, name: 'Weekly', frequency: 'weekly', anchorDate: '2025-11-03', template: template('20'), sendEmail: false, copyPaymentUrl: false }));
    const paused = await w.run(w.ctxA, (s) => pauseSchedule(s, sched.id, sched.version));
    expect(paused.status).toBe('paused');
    expect(paused.nextRunAt).toBeNull();
    expect(paused.catchUp!.length).toBeGreaterThan(10); // many missed weeks up to today
    const skipped = await w.run(w.ctxA, (s) => resumeSchedule(s, sched.id, { version: paused.version, mode: 'skip' }));
    expect(skipped.status).toBe('active');
    expect(skipped.catchUp).toEqual([]);
    expect(skipped.occurrences).toEqual([]);
    expect(skipped.nextOccurrenceDate! > '2026-09-16').toBe(true);

    const sched2 = await w.run(w.ctxA, (s) => createSchedule(s, { contactId: customerId, name: 'Quarterly', frequency: 'quarterly', anchorDate: '2026-01-15', endDate: '2026-12-31', template: template('900'), sendEmail: false, copyPaymentUrl: false }));
    const p2 = await w.run(w.ctxA, (s) => pauseSchedule(s, sched2.id, sched2.version));
    expect(p2.catchUp!.map((o) => o.date)).toEqual(['2026-01-15', '2026-04-15', '2026-07-15']);
    const caught = await w.run(w.ctxA, (s) => resumeSchedule(s, sched2.id, { version: p2.version, mode: 'catch_up' }));
    expect(caught.occurrences!.length).toBe(3);
    expect(caught.nextOccurrenceDate).toBe('2026-10-15');
    const cancelled = await w.run(w.ctxA, (s) => cancelSchedule(s, sched2.id, caught.version, 'Client churned'));
    expect(cancelled.status).toBe('cancelled');
    expect((await dueSchedules(w.tdb.app.db, new Date('2030-01-01T00:00:00Z'))).some((d) => d.id === sched2.id)).toBe(false);
  });

  it('end date completes the schedule and a template with a bad account is rejected up front', async () => {
    const sched = await w.run(w.ctxA, (s) => createSchedule(s, { contactId: customerId, name: 'Short', frequency: 'monthly', anchorDate: '2026-02-01', endDate: '2026-03-15', template: template('10'), sendEmail: false, copyPaymentUrl: false }));
    const r = await runScheduleIssuance(w.tdb.app.db, w.companyA, sched.id, 'job', new Date('2026-06-01T12:00:00Z'));
    expect(r.issued).toHaveLength(2);
    expect((await w.run(w.ctxA, (s) => getSchedule(s, sched.id))).status).toBe('completed');
    await expect(
      w.run(w.ctxA, (s) => createSchedule(s, { contactId: customerId, name: 'Bad', frequency: 'monthly', anchorDate: '2026-02-01', template: { lines: [{ description: 'x', quantity: '1', unitPrice: '1', incomeAccountId: acct.get('5110')!, taxRateIds: [] }] }, sendEmail: false, copyPaymentUrl: false })),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('SimpleFIN sync', () => {
  const fixture = new FixtureSimpleFinClient(new Date('2026-09-10T12:00:00Z'));
  let connectionId: string;
  let checkingBankAccountId: string;

  it('claims a token once, encrypts the access URL, discovers and links accounts', async () => {
    const conn = await w.run(w.ctxA, (s) => connectSimpleFin(s, fixture, { name: 'Demo Bank', setupToken: 'demo-token-1', syncIntervalMinutes: 360 }));
    connectionId = conn.id;
    expect(conn.status).toBe('active');
    await expect(w.run(w.ctxA, (s) => connectSimpleFin(s, fixture, { name: 'Dup', setupToken: 'demo-token-1', syncIntervalMinutes: 360 }))).rejects.toMatchObject({ code: 'external_error' });
    const stored = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => (await tx.execute<{ c: string }>(sql`select access_url_ciphertext as c from bank_connections where id = ${connectionId}`)).rows[0]!.c);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain('beta-bridge');
    const discovered = await w.run(w.ctxA, (s) => discoverAccounts(s, fixture, connectionId));
    expect(discovered.map((d) => d.providerAccountId).sort()).toEqual(['demo-card', 'demo-checking']);
    const linked = await w.run(w.ctxA, (s) =>
      linkProviderAccounts(s, connectionId, {
        version: conn.version,
        links: [
          { providerAccountId: 'demo-checking', create: { name: 'Demo Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! } },
          { providerAccountId: 'demo-card', create: { name: 'Demo Visa', kind: 'credit_card', ledgerAccountId: acct.get('2000')! } },
        ],
      }),
    );
    expect(linked.accounts!.length).toBe(2);
    checkingBankAccountId = linked.accounts!.find((a) => a.providerAccountId === 'demo-checking')!.id;
  });

  it('syncs with an overlapping window without duplicating, updates pending→posted, and flags changes to reviewed rows', async () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const callsBefore = fixture.calls.length;
    const r1 = await syncConnection(w.tdb.app.db, fixture, w.companyA, connectionId, 'j1', now);
    expect(r1.ok).toBe(true);
    expect(r1.inserted).toBe(8);
    const initialCalls = fixture.calls.slice(callsBefore).map((c) => c.startDate!.toISOString().slice(0, 10)).sort();
    expect(initialCalls[0]).toBe('2026-07-12'); // 60-day initial window, fetched in ≤45-day chunks
    expect(initialCalls.length).toBe(2);
    const inbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingBankAccountId }));
    expect(inbox.items).toHaveLength(5);
    expect(inbox.items.find((t) => t.description === 'STREAMING SERVICE')!.pending).toBe(true);

    // second sync a day later with the 5-day overlap: nothing duplicated
    const later = new Date('2026-09-11T12:00:00Z');
    const r2 = await syncConnection(w.tdb.app.db, fixture, w.companyA, connectionId, 'j2', later);
    expect(r2.inserted).toBe(0);
    expect(fixture.calls[fixture.calls.length - 1]!.startDate!.toISOString().slice(0, 10)).toBe('2026-09-05');
    expect((await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingBankAccountId }))).items).toHaveLength(5);

    // provider posts the pending item with a slightly different amount → updated in place (unreviewed)
    const checking = fixture.accounts.find((a) => a.id === 'demo-checking')!;
    const pending = checking.transactions.find((t) => t.id === 'chk-5')!;
    pending.pending = false;
    pending.postedAt = Math.floor(later.getTime() / 1000);
    pending.amount = '-19.99';
    const r3 = await syncConnection(w.tdb.app.db, fixture, w.companyA, connectionId, 'j3', later);
    expect(r3.updated).toBe(1);
    const posted = (await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingBankAccountId }))).items.find((t) => t.description === 'STREAMING SERVICE')!;
    expect(posted.pending).toBe(false);
    expect(posted.amount).toBe('-19.99');
    expect(posted.changeNote).toMatch(/amount -18.99 → -19.99/);

    // categorize a transaction inside the overlap window, then the provider changes it:
    // the posted journal is untouched, the row is flagged
    const coffee = (await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingBankAccountId }))).items.find((t) => t.description === 'TRANSFER TO CARD')!;
    const done = await w.run(w.ctxA, (s) => categorizeTransaction(s, coffee.id, { version: coffee.version, lines: [{ accountId: acct.get('5900')!, amount: '300.00', description: 'Misc' }] }));
    checking.transactions.find((t) => t.id === 'chk-4')!.amount = '-305.00';
    const r4 = await syncConnection(w.tdb.app.db, fixture, w.companyA, connectionId, 'j4', later);
    expect(r4.changed).toBe(1);
    const flagged = (await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingBankAccountId, status: 'categorized' }))).items.find((t) => t.id === coffee.id)!;
    expect(flagged.amount).toBe('-300.00'); // not rewritten
    expect(flagged.changeNote).toMatch(/Provider changed a reviewed transaction/);
    const entryAmount = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => (await tx.execute<{ d: string }>(sql`select sum(debit)::text as d from journal_lines where entry_id = ${done.journalEntryId}`)).rows[0]!.d);
    expect(Number(entryAmount).toFixed(2)).toBe('300.00');
  });

  it('revoked access marks the connection and stops polling; reconnecting restores it', async () => {
    fixture.failNext = new SimpleFinError('revoked', 'auth_revoked', 403);
    const r = await syncConnection(w.tdb.app.db, fixture, w.companyA, connectionId, 'j5', new Date('2026-09-12T12:00:00Z'));
    expect(r.ok).toBe(false);
    const conns = await w.run(w.ctxA, (s) => listConnections(s));
    const c = conns.find((x) => x.id === connectionId)!;
    expect(c.status).toBe('revoked');
    expect(c.nextSyncAt).toBeNull();
    expect((await dueConnections(w.tdb.app.db, new Date('2030-01-01T00:00:00Z'))).some((d) => d.id === connectionId)).toBe(false);
    const re = await w.run(w.ctxA, (s) => reconnectSimpleFin(s, fixture, connectionId, { version: c.version, setupToken: 'demo-token-2' }));
    expect(re.status).toBe('active');
    expect(re.accounts!.length).toBe(2); // links preserved
    const r2 = await syncConnection(w.tdb.app.db, fixture, w.companyA, connectionId, 'j6', new Date('2026-09-12T13:00:00Z'));
    expect(r2.ok).toBe(true);
    expect(r2.inserted).toBe(0);
    // transient failures back off but keep the connection active until 3 strikes
    fixture.failNext = new SimpleFinError('boom', 'network');
    await syncConnection(w.tdb.app.db, fixture, w.companyA, connectionId, 'j7', new Date('2026-09-12T14:00:00Z'));
    const after = (await w.run(w.ctxA, (s) => listConnections(s))).find((x) => x.id === connectionId)!;
    expect(after.status).toBe('active');
    expect(after.consecutiveFailures).toBe(1);
    expect(after.lastError).toContain('boom');
    const gone = await w.run(w.ctxA, (s) => disconnect(s, connectionId, after.version));
    expect(gone.status).toBe('revoked');
  });
});
