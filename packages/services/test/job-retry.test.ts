import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createContact, createDraftInvoice, issueInvoice, jobStatus, listAudit, queueInvoiceEmail, retryFailedJob, ServiceError } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

/**
 * The retry service reads pg-boss's job table. The worker creates the real
 * schema; here a minimal stand-in with the columns the services read is enough
 * (apps/worker/test/job-retry.test.ts covers the dispatcher with real pg-boss).
 */
let w: TestWorld;
let acct: Map<string, string>;
let customerId: string;

beforeAll(async () => {
  w = await createWorld();
  await w.tdb.admin.db.execute(sql`
    create schema if not exists pgboss;
    create table pgboss.job (
      id uuid primary key default gen_random_uuid(), name text not null, data jsonb, state text not null,
      singleton_key text, created_on timestamptz not null default now(), completed_on timestamptz,
      retry_count int not null default 0, output jsonb);
    grant usage on schema pgboss to evenbooks_app;
    grant select on pgboss.job to evenbooks_app;`);
  acct = await w.accountsByCode(w.ctxA);
  customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Retry Customer', isCustomer: true, isVendor: false, email: 'r@example.test' }))).id;
});
afterAll(() => w.destroy());

async function failedJob(name: string, data: Record<string, unknown>, state = 'failed', singletonKey: string | null = null): Promise<string> {
  const r = await w.tdb.admin.db.execute<{ id: string }>(sql`
    insert into pgboss.job (name, data, state, singleton_key, retry_count, output)
    values (${name}, ${JSON.stringify(data)}::jsonb, ${state}, ${singletonKey}, 5, ${JSON.stringify({ message: 'boom' })}::jsonb) returning id::text`);
  return r.rows[0]!.id;
}

async function issuedInvoiceWithEmail() {
  const draft = await w.run(w.ctxA, (s) => createDraftInvoice(s, { contactId: customerId, issueDate: '2026-06-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }));
  const inv = await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
  const msg = await w.run(w.ctxA, (s) => queueInvoiceEmail(s, inv.id, { to: 'r@example.test' }));
  return { inv, msg };
}

const setEmailStatus = (id: string, status: string) => w.tdb.admin.db.execute(sql`update email_messages set status = ${status} where id = ${id}`);
const retryOutbox = (jobId: string) => w.tdb.admin.db.execute<{ event_type: string; payload: Record<string, unknown>; dispatched_at: string | null }>(sql`select event_type, payload, dispatched_at from outbox_events where dedupe_key = ${'job.retry:' + jobId}`);
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof ServiceError ? e.code : String(e)));

describe('retrying failed jobs', () => {
  it('queues one retry per failed job through the outbox, audits it, and shows it on the status page', async () => {
    const { inv, msg } = await issuedInvoiceWithEmail();
    const jobId = await failedJob('email.send', { companyId: w.companyA, emailMessageId: msg.id, invoiceId: inv.id, message: null, outboxId: '12', actorId: 'user_a' }, 'failed', `email.send:${msg.id}`);

    const first = await w.run(w.ctxA, (s) => retryFailedJob(s, jobId));
    expect(first).toMatchObject({ jobId, queue: 'email.send', status: 'queued', retry: { dispatchedAt: null } });
    const again = await w.run(w.ctxA, (s) => retryFailedJob(s, jobId));
    expect(again.status).toBe('already_requested');

    const rows = (await retryOutbox(jobId)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('job.retry');
    expect(rows[0]!.payload).toMatchObject({ queue: 'email.send', singletonKey: `email.send:${msg.id}`, retryOfJobId: jobId, companyId: w.companyA, data: { companyId: w.companyA, emailMessageId: msg.id, invoiceId: inv.id, message: null } });
    // dispatcher bookkeeping from the failed job is not carried over
    expect(rows[0]!.payload.data).not.toHaveProperty('outboxId');

    const audit = await w.run(w.ctxA, (s) => listAudit(s, { limit: 10, entityType: 'job', entityId: jobId }));
    expect(audit.items.map((e) => e.action)).toEqual(['job.retry_requested']);
    expect(audit.items[0]!.details).toMatchObject({ queue: 'email.send', emailMessageId: msg.id, invoiceId: inv.id });

    const status = await w.run(w.ctxA, (s) => jobStatus(s));
    const listed = status.failedJobs.find((j) => j.id === jobId)!;
    expect(listed.retryable).toBe(true);
    expect(listed.retry?.requestedAt).toBe(first.retry.requestedAt);
  });

  it('refuses emails that were sent, are in flight, or may have been delivered', async () => {
    for (const [status, pattern] of [
      ['sent', /already sent/],
      ['sending', /being sent/],
      ['uncertain', /uncertain.*Check the email provider/],
      ['failed', /Resend/],
      ['bounced', /Resend/],
    ] as const) {
      const { inv, msg } = await issuedInvoiceWithEmail();
      await setEmailStatus(msg.id, status);
      const jobId = await failedJob('email.send', { companyId: w.companyA, emailMessageId: msg.id, invoiceId: inv.id, message: null });
      const err = await w.run(w.ctxA, (s) => retryFailedJob(s, jobId)).catch((e: unknown) => e);
      expect(err, status).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).code).toBe('invalid_state');
      expect((err as ServiceError).message).toMatch(pattern);
      expect((await retryOutbox(jobId)).rows).toHaveLength(0);
    }
  });

  it('checks the source record for PDF, recurring and bank sync jobs', async () => {
    const { inv } = await issuedInvoiceWithEmail();
    const pdf = await failedJob('invoice.issued', { companyId: w.companyA, invoiceId: inv.id });
    expect((await w.run(w.ctxA, (s) => retryFailedJob(s, pdf))).status).toBe('queued');

    const missingSchedule = await failedJob('recurring.issue', { companyId: w.companyA, scheduleId: '00000000-0000-4000-8000-000000000001' }, 'failed', 'recurring:x');
    expect(await code(w.run(w.ctxA, (s) => retryFailedJob(s, missingSchedule)))).toBe('not_found');
    const missingConnection = await failedJob('bank.sync', { companyId: w.companyA, connectionId: '00000000-0000-4000-8000-000000000002' });
    expect(await code(w.run(w.ctxA, (s) => retryFailedJob(s, missingConnection)))).toBe('not_found');
  });

  it('only retries failed jobs of retryable queues in the caller’s company', async () => {
    const { inv, msg } = await issuedInvoiceWithEmail();
    const data = { companyId: w.companyA, emailMessageId: msg.id, invoiceId: inv.id, message: null };
    const aJob = await failedJob('email.send', data);
    // another company cannot see or retry it
    expect(await code(w.run(w.ctxB, (s) => retryFailedJob(s, aJob)))).toBe('not_found');
    expect((await w.run(w.ctxB, (s) => jobStatus(s))).failedJobs.some((j) => j.id === aJob)).toBe(false);
    // not failed (completed, or still retrying) -> nothing to retry
    expect(await code(w.run(w.ctxA, async (s) => retryFailedJob(s, await failedJob('email.send', data, 'completed'))))).toBe('not_found');
    expect(await code(w.run(w.ctxA, async (s) => retryFailedJob(s, await failedJob('email.send', data, 'retry'))))).toBe('not_found');
    // queues outside the allow-list, and junk ids
    const maint = await failedJob('maintenance', { companyId: w.companyA });
    expect(await code(w.run(w.ctxA, (s) => retryFailedJob(s, maint)))).toBe('validation');
    expect((await w.run(w.ctxA, (s) => jobStatus(s))).failedJobs.find((j) => j.id === maint)?.retryable).toBe(false);
    expect(await code(w.run(w.ctxA, (s) => retryFailedJob(s, 'not-a-uuid')))).toBe('not_found');
  });
});
