import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { withCompany } from '@evenbooks/db';
import { createTestDatabase, type TestDatabase } from '@evenbooks/db/testing';
import { LocalStorage, LogEmailSender, FixtureSimpleFinClient, FixturePaymentProcessor } from '@evenbooks/integrations';
import { DEFAULT_PLATFORM_FEE } from '@evenbooks/domain';
import { createContact, createDraftInvoice, issueInvoice, listInvoiceEmails, queueInvoiceEmail, resolveCompanyForOrg, runInCompany, listAccounts, getInvoice } from '@evenbooks/services';
import { ensureQueues, QUEUES } from '../src/queues';
import { registerJobs } from '../src/jobs';
import { dispatchOutbox } from '../src/dispatcher';

let tdb: TestDatabase;
let boss: PgBoss;
let tmp: string;
let storage: LocalStorage;
const sender = new LogEmailSender();
let companyId: string;

const ctx = () => ({ companyId, actorId: 'user_w', actorType: 'user' as const });

async function waitFor(pred: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('timed out waiting');
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  tdb = await createTestDatabase('evenbooks_worker');
  tmp = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-worker-'));
  storage = new LocalStorage(tmp);
  boss = new PgBoss({ connectionString: tdb.appUrl, schema: 'pgboss' });
  boss.on('error', () => {});
  await boss.start();
  await ensureQueues(boss);
  registerJobs({ db: tdb.app.db, boss, storage, sender, emailConfig: { from: 'Evenbooks <billing@test>', replyTo: null, configurationSet: null }, simplefin: new FixtureSimpleFinClient(), processor: new FixturePaymentProcessor('https://evenbooks.test'), feeConfig: DEFAULT_PLATFORM_FEE, publicBaseUrl: 'https://evenbooks.test' });
  const company = await resolveCompanyForOrg(tdb.app.db, { clerkOrgId: 'org_w', name: 'Worker Co', actorId: 'user_w' });
  companyId = company.id;
});
afterAll(async () => {
  await boss.stop({ graceful: false, close: true, timeout: 5_000 }).catch(() => {});
  await tdb.destroy();
  await rm(tmp, { recursive: true, force: true });
});

describe('worker', () => {
  it('dispatches outbox events to durable jobs: invoice issue → PDF, email queue → sent; repeats are harmless', async () => {
    const accounts = await runInCompany(tdb.app.db, ctx(), (s) => listAccounts(s));
    const income = accounts.find((a) => a.code === '4100')!.id;
    const contact = await runInCompany(tdb.app.db, ctx(), (s) => createContact(s, { name: 'Worker Customer', isCustomer: true, isVendor: false, email: 'w@example.test' }));
    const draft = await runInCompany(tdb.app.db, ctx(), (s) => createDraftInvoice(s, { contactId: contact.id, issueDate: '2026-09-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '250', incomeAccountId: income, taxRateIds: [] }] }));
    const issued = await runInCompany(tdb.app.db, ctx(), (s) => issueInvoice(s, draft.id, { version: draft.version }));
    const queued = await runInCompany(tdb.app.db, ctx(), (s) => queueInvoiceEmail(s, issued.id, { to: 'w@example.test' }));

    const pending = await withCompany(tdb.app.db, ctx(), async (tx) => (await tx.execute<{ n: string }>(sql`select count(*)::text as n from outbox_events where dispatched_at is null`)).rows[0]!.n);
    expect(Number(pending)).toBe(2);
    const dispatched = await dispatchOutbox(tdb.app.db, boss);
    expect(dispatched).toBe(2);
    // dispatching again is a no-op
    expect(await dispatchOutbox(tdb.app.db, boss)).toBe(0);

    await waitFor(async () => (await runInCompany(tdb.app.db, ctx(), (s) => getInvoice(s, issued.id))).currentPdfAttachmentId !== null);
    await waitFor(async () => (await runInCompany(tdb.app.db, ctx(), (s) => listInvoiceEmails(s, issued.id))).find((m) => m.id === queued.id)?.status === 'sent');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.attachments?.[0]?.contentType).toBe('application/pdf');
    expect(sender.sent[0]!.companyId).toBe(companyId);

    // Re-sending the same job payload (as a duplicate delivery would) does not send twice.
    await boss.send(QUEUES.emailSend, { companyId, emailMessageId: queued.id, invoiceId: issued.id, message: null }, { singletonKey: `dup-${Date.now()}` });
    await new Promise((r) => setTimeout(r, 3000));
    expect(sender.sent).toHaveLength(1);

    // Failed permanent send lands in a visible state rather than retrying forever.
    const second = await runInCompany(tdb.app.db, ctx(), (s) => queueInvoiceEmail(s, issued.id, { to: 'w2@example.test', isResend: true }));
    sender.failNext = { transient: false, error: 'MessageRejected' };
    await dispatchOutbox(tdb.app.db, boss);
    await waitFor(async () => (await runInCompany(tdb.app.db, ctx(), (s) => listInvoiceEmails(s, issued.id))).find((m) => m.id === second.id)?.status === 'failed');

    // Routing is taken from the persisted message, even if job metadata names another company.
    const third = await runInCompany(tdb.app.db, ctx(), (s) => queueInvoiceEmail(s, issued.id, { to: 'routing@example.test', isResend: true }));
    await boss.send(QUEUES.emailSend, {
      companyId: '22222222-2222-4222-8222-222222222222', emailMessageId: third.id, invoiceId: issued.id, message: null,
    });
    await waitFor(async () => (await runInCompany(tdb.app.db, ctx(), (s) => listInvoiceEmails(s, issued.id))).find((m) => m.id === third.id)?.status === 'sent');
    expect(sender.sent.at(-1)?.companyId).toBe(companyId);
  });

  it('bank sync tick and recurring tick run without work and heartbeat is recorded', async () => {
    await boss.send(QUEUES.recurringTick, {}, { singletonKey: 'test-tick' });
    await boss.send(QUEUES.bankSyncTick, {}, { singletonKey: 'test-tick' });
    await boss.send(QUEUES.outboxDispatch, {}, { singletonKey: 'test-hb' });
    await waitFor(async () => {
      const r = await tdb.app.pool.query(`select count(*)::int as n from pgboss.job where name in ('recurring.tick','bank.sync.tick','outbox.dispatch') and state = 'completed'`);
      return r.rows[0].n >= 3;
    });
    const hb = await tdb.admin.pool.query('select at from worker_heartbeat where id = 1');
    expect(hb.rows).toHaveLength(1);
  });
});
