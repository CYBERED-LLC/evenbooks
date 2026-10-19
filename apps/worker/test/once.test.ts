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
import { createContact, createDraftInvoice, issueInvoice, listInvoiceEmails, queueInvoiceEmail, resolveCompanyForOrg, runInCompany, listAccounts, getInvoice } from '@evenbooks/services';
import { ensureQueues } from '../src/queues';
import { runOnce } from '../src/once';

let tdb: TestDatabase;
let boss: PgBoss;
let tmp: string;
let storage: LocalStorage;
const sender = new LogEmailSender();
let companyId: string;
const ctx = () => ({ companyId, actorId: 'user_o', actorType: 'user' as const });

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
  tdb = await createTestDatabase('evenbooks_worker_once');
  tmp = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-worker-once-'));
  storage = new LocalStorage(tmp);
  // Same construction as the cron entrypoint: pg-boss's own scheduler is off.
  boss = new PgBoss({ connectionString: tdb.appUrl, schema: 'pgboss', schedule: false });
  boss.on('error', () => {});
  await boss.start();
  await ensureQueues(boss);
  const company = await resolveCompanyForOrg(tdb.app.db, { clerkOrgId: 'org_o', name: 'Once Co', actorId: 'user_o' });
  companyId = company.id;
});
afterAll(async () => {
  await boss.stop({ graceful: false, close: true, timeout: 5_000 }).catch(() => {});
  await tdb.destroy();
  await rm(tmp, { recursive: true, force: true });
});

const deps = () => ({ db: tdb.app.db, boss, storage, sender, emailConfig: { from: 'Evenbooks <billing@test>', replyTo: null, configurationSet: null }, simplefin: new FixtureSimpleFinClient(), processor: new FixturePaymentProcessor('https://evenbooks.test'), feeConfig: DEFAULT_PLATFORM_FEE, publicBaseUrl: 'https://evenbooks.test' });

describe('runOnce (cron mode)', () => {
  it('drains the outbox and queues in a single pass: issued invoice gets its PDF, queued email is sent, heartbeat recorded', async () => {
    const accounts = await runInCompany(tdb.app.db, ctx(), (s) => listAccounts(s));
    const income = accounts.find((a) => a.code === '4100')!.id;
    const contact = await runInCompany(tdb.app.db, ctx(), (s) => createContact(s, { name: 'Once Customer', isCustomer: true, isVendor: false, email: 'o@example.test' }));
    const draft = await runInCompany(tdb.app.db, ctx(), (s) => createDraftInvoice(s, { contactId: contact.id, issueDate: '2026-09-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '100', incomeAccountId: income, taxRateIds: [] }] }));
    const issued = await runInCompany(tdb.app.db, ctx(), (s) => issueInvoice(s, draft.id, { version: draft.version }));
    const queued = await runInCompany(tdb.app.db, ctx(), (s) => queueInvoiceEmail(s, issued.id, { to: 'o@example.test' }));

    const result = await runOnce(deps(), { maxMs: 30_000, pollMs: 250 });

    expect(result.dispatched).toBe(2);
    expect(result.remaining).toBe(0);
    expect(result.ms).toBeLessThan(30_000);
    expect((await runInCompany(tdb.app.db, ctx(), (s) => getInvoice(s, issued.id))).currentPdfAttachmentId).not.toBeNull();
    expect((await runInCompany(tdb.app.db, ctx(), (s) => listInvoiceEmails(s, issued.id))).find((m) => m.id === queued.id)?.status).toBe('sent');
    expect(sender.sent).toHaveLength(1);

    const hb = await withSystem(tdb.app.db, async (tx) => (await tx.execute<{ age: string }>(sql`select extract(epoch from now() - at)::text as age from worker_heartbeat where id = 1`)).rows[0]);
    expect(Number(hb?.age)).toBeLessThan(60);
    const left = await withSystem(tdb.app.db, async (tx) => (await tx.execute<{ n: string }>(sql`select count(*)::text as n from pgboss.job where state in ('created','retry','active')`)).rows[0]!.n);
    expect(Number(left)).toBe(0);
  });

  it('a second pass with nothing to do returns quickly and sends nothing', async () => {
    const before = sender.sent.length;
    const result = await runOnce(deps(), { maxMs: 30_000, pollMs: 250 });
    expect(result.dispatched).toBe(0);
    expect(result.remaining).toBe(0);
    expect(result.ms).toBeLessThan(10_000);
    expect(sender.sent).toHaveLength(before);
  });
});
