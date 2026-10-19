import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { withSystem } from '@evenbooks/db';
import { createTestDatabase, type TestDatabase } from '@evenbooks/db/testing';
import { LocalStorage, LogEmailSender, FixtureSimpleFinClient, FixturePaymentProcessor } from '@evenbooks/integrations';
import { DEFAULT_PLATFORM_FEE } from '@evenbooks/domain';
import { createContact, createDraftInvoice, issueInvoice, listAccounts, listInvoiceEmails, queueInvoiceEmail, resolveCompanyForOrg, retryFailedJob, runInCompany } from '@evenbooks/services';
import { ensureQueues, QUEUES } from '../src/queues';
import { registerJobs } from '../src/jobs';
import { dispatchOutbox } from '../src/dispatcher';

/**
 * Retry from /settings/jobs, end to end with real pg-boss: the request goes
 * through the outbox, the dispatcher re-sends the failed payload to its own
 * queue, and the idempotent consumer does the work exactly once even when the
 * retry is dispatched twice.
 */
let tdb: TestDatabase;
let boss: PgBoss;
let tmp: string;
const sender = new LogEmailSender();
let companyId: string;
const ctx = () => ({ companyId, actorId: 'user_r', actorType: 'user' as const });

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
  tdb = await createTestDatabase('evenbooks_worker_retry');
  tmp = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-retry-'));
  boss = new PgBoss({ connectionString: tdb.appUrl, schema: 'pgboss', schedule: false });
  boss.on('error', () => {});
  await boss.start();
  await ensureQueues(boss);
  companyId = (await resolveCompanyForOrg(tdb.app.db, { clerkOrgId: 'org_r', name: 'Retry Co', actorId: 'user_r' })).id;
});
afterAll(async () => {
  await boss.stop({ graceful: false, close: true, timeout: 5_000 }).catch(() => {});
  await tdb.destroy();
  await rm(tmp, { recursive: true, force: true });
});

describe('failed job retry', () => {
  it('re-runs a failed email job once through the outbox; a duplicate dispatch does not send twice', async () => {
    const accounts = await runInCompany(tdb.app.db, ctx(), (s) => listAccounts(s));
    const income = accounts.find((a) => a.code === '4100')!.id;
    const contact = await runInCompany(tdb.app.db, ctx(), (s) => createContact(s, { name: 'Retry Customer', isCustomer: true, isVendor: false, email: 'r@example.test' }));
    const draft = await runInCompany(tdb.app.db, ctx(), (s) => createDraftInvoice(s, { contactId: contact.id, issueDate: '2026-09-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '90', incomeAccountId: income, taxRateIds: [] }] }));
    const issued = await runInCompany(tdb.app.db, ctx(), (s) => issueInvoice(s, draft.id, { version: draft.version }));
    const msg = await runInCompany(tdb.app.db, ctx(), (s) => queueInvoiceEmail(s, issued.id, { to: 'r@example.test' }));
    // Consume the original outbox rows without a worker, then fail the email job as exhausted retries would.
    await dispatchOutbox(tdb.app.db, boss);
    const failed = await tdb.app.pool.query<{ id: string }>(
      `update pgboss.job set state = 'failed', output = '{"message":"storage down"}'::jsonb where name = $1 and data->>'emailMessageId' = $2 returning id::text`,
      [QUEUES.emailSend, msg.id],
    );
    const failedId = failed.rows[0]!.id;

    registerJobs(
      { db: tdb.app.db, boss, storage: new LocalStorage(tmp), sender, emailConfig: { from: 'Evenbooks <billing@test>', replyTo: null, configurationSet: null }, simplefin: new FixtureSimpleFinClient(), processor: new FixturePaymentProcessor('https://evenbooks.test'), feeConfig: DEFAULT_PLATFORM_FEE, publicBaseUrl: 'https://evenbooks.test' },
      { pollingIntervalSeconds: 0.5 },
    );

    const res = await runInCompany(tdb.app.db, { ...ctx(), actorId: 'admin_r' }, (s) => retryFailedJob(s, failedId));
    expect(res.status).toBe('queued');
    expect(await dispatchOutbox(tdb.app.db, boss)).toBe(1);

    const retried = await tdb.app.pool.query<{ data: Record<string, unknown> }>(`select data from pgboss.job where name = $1 and data->>'retryOfJobId' = $2`, [QUEUES.emailSend, failedId]);
    expect(retried.rows).toHaveLength(1);
    expect(retried.rows[0]!.data).toMatchObject({ companyId, emailMessageId: msg.id, invoiceId: issued.id });

    await waitFor(async () => (await runInCompany(tdb.app.db, ctx(), (s) => listInvoiceEmails(s, issued.id))).find((m) => m.id === msg.id)?.status === 'sent');
    expect(sender.sent).toHaveLength(1);

    // At-least-once dispatch: replaying the retry row sends another job, which finds the message sent and does nothing.
    await withSystem(tdb.app.db, (tx) => tx.execute(sql`update outbox_events set dispatched_at = null where dedupe_key = ${'job.retry:' + failedId}`));
    expect(await dispatchOutbox(tdb.app.db, boss)).toBe(1);
    await waitFor(async () => (await tdb.app.pool.query(`select count(*)::int as n from pgboss.job where name = $1 and data->>'retryOfJobId' = $2 and state = 'completed'`, [QUEUES.emailSend, failedId])).rows[0].n === 2);
    expect(sender.sent).toHaveLength(1);

    // Asking again for the same failed job queues nothing new.
    const again = await runInCompany(tdb.app.db, ctx(), (s) => retryFailedJob(s, failedId));
    expect(again.status).toBe('already_requested');
    expect(await dispatchOutbox(tdb.app.db, boss)).toBe(0);
  });
});
