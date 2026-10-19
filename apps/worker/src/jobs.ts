import { sql } from 'drizzle-orm';
import type { PgBoss, Job } from 'pg-boss';
import { withSystem, type Db } from '@evenbooks/db';
import type { EmailSender, EmailConfig, ObjectStorage, SimpleFinClient, PaymentProcessorClient } from '@evenbooks/integrations';
import type { PlatformFeeConfig } from '@evenbooks/domain';
import {
  cleanupOrphanAttachments,
  refreshActiveEmailSenders,
  dueConnections,
  dueSchedules,
  ensureInvoicePdf,
  markStuckSendsUncertain,
  retryProcessorEvents,
  settlePendingChargeFees,
  runJobInCompany,
  runScheduleIssuance,
  sendQueuedEmail,
  syncConnection,
  ServiceError,
} from '@evenbooks/services';
import { QUEUES, type BankSyncJob, type EmailSendJob, type InvoiceIssuedJob, type RecurringIssueJob } from './queues';
import { dispatchOutbox } from './dispatcher';
import { logger } from './logger';

export interface WorkerDeps {
  db: Db;
  boss: PgBoss;
  storage: ObjectStorage;
  sender: EmailSender;
  emailConfig: EmailConfig;
  identities?: import('@evenbooks/integrations').EmailIdentityManager;
  simplefin: SimpleFinClient;
  processor: PaymentProcessorClient;
  feeConfig: PlatformFeeConfig;
  publicBaseUrl: string;
}

async function heartbeat(db: Db): Promise<void> {
  await withSystem(db, (tx) =>
    tx.execute(sql`insert into worker_heartbeat (id, at) values (1, now()) on conflict (id) do update set at = excluded.at`),
  ).catch(() => {});
}

export interface WorkTuning {
  /** Base poll interval per queue in seconds (pg-boss minimum 0.5). Default 2. */
  pollingIntervalSeconds?: number;
  /** Independent pollers per queue. Default 1; the one-shot run raises it to drain faster. */
  localConcurrency?: number;
}

export function registerJobs(deps: WorkerDeps, tuning: WorkTuning = {}): void {
  const { boss, db } = deps;

  const work = <T extends object>(queue: string, handler: (job: Job<T>) => Promise<unknown>, opts: { batchSize?: number; pollingIntervalSeconds?: number } = {}) => {
    const pollingIntervalSeconds = opts.pollingIntervalSeconds ?? tuning.pollingIntervalSeconds ?? 2;
    void boss.work<T>(queue, { batchSize: opts.batchSize ?? 1, pollingIntervalSeconds, localConcurrency: tuning.localConcurrency ?? 1 }, async (jobs) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          const result = await handler(job);
          logger.info({ queue, jobId: job.id, ms: Date.now() - started }, 'job done');
          return result;
        } catch (err) {
          logger.error({ queue, jobId: job.id, err, ms: Date.now() - started }, 'job failed');
          throw err;
        }
      }
    });
  };

  // Outbox → queues
  work(QUEUES.outboxDispatch, async () => {
    const n = await dispatchOutbox(db, boss);
    await heartbeat(db);
    return { dispatched: n };
  }, { pollingIntervalSeconds: 5 });

  // PDF after issue (+ nothing else; email is queued separately by the issuing flow or the user)
  work<InvoiceIssuedJob>(QUEUES.invoiceIssued, async (job) => {
    const { companyId, invoiceId } = job.data;
    return runJobInCompany(db, { companyId, actorId: job.data.actorId ?? 'system', actorType: 'job', jobId: job.id }, async (s) => {
      const { schema } = await import('@evenbooks/db');
      const { eq } = await import('drizzle-orm');
      const [inv] = await s.tx.select({ status: schema.invoices.status }).from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
      if (!inv || inv.status === 'draft') return { skipped: true };
      // ensure = generate once under a per-invoice lock (a concurrent email job may get there first)
      const attachmentId = await ensureInvoicePdf(s, deps.storage, invoiceId, deps.publicBaseUrl);
      return { attachmentId };
    });
  });

  // Email send (state machine in the service; transient failures throw so pg-boss retries)
  work<EmailSendJob>(QUEUES.emailSend, async (job) => {
    try {
      return await sendQueuedEmail({ db, storage: deps.storage, sender: deps.sender, config: deps.emailConfig, baseUrl: deps.publicBaseUrl, identities: deps.identities }, job.data.emailMessageId, job.data.message ?? null, job.id);
    } catch (err) {
      if (err instanceof ServiceError && err.code === 'not_found') return { skipped: 'message missing' };
      throw err;
    }
  });

  // Recurring: tick fans out one job per due schedule (singleton per schedule)
  work(QUEUES.recurringTick, async () => {
    const due = await dueSchedules(db);
    for (const s of due) {
      await boss.send(QUEUES.recurringIssue, { companyId: s.companyId, scheduleId: s.id } satisfies RecurringIssueJob, { singletonKey: `recurring:${s.id}` });
    }
    return { due: due.length };
  });
  work<RecurringIssueJob>(QUEUES.recurringIssue, async (job) => runScheduleIssuance(db, job.data.companyId, job.data.scheduleId, job.id));

  // Bank sync: tick fans out per connection with per-connection singleton keys
  work(QUEUES.bankSyncTick, async () => {
    const due = await dueConnections(db);
    for (const c of due) {
      await boss.send(QUEUES.bankSync, { companyId: c.companyId, connectionId: c.id } satisfies BankSyncJob, { singletonKey: `bank-sync:${c.id}` });
    }
    return { due: due.length };
  });
  work<BankSyncJob>(QUEUES.bankSync, async (job) => syncConnection(db, deps.simplefin, job.data.companyId, job.data.connectionId, job.id));

  // Maintenance
  work(QUEUES.maintenance, async () => {
    const senderChecks = deps.identities ? await refreshActiveEmailSenders(db, deps.identities) : 0;
    const orphans = await cleanupOrphanAttachments(db, deps.storage);
    const uncertain = await markStuckSendsUncertain(db);
    const processor = await retryProcessorEvents(db, { client: deps.processor, feeConfig: deps.feeConfig });
    const chargeFees = await settlePendingChargeFees(db, { client: deps.processor, feeConfig: deps.feeConfig });
    return { orphans, uncertain, processor, chargeFees, senderChecks };
  });
}

export async function scheduleTicks(boss: PgBoss): Promise<void> {
  await boss.schedule(QUEUES.outboxDispatch, '*/1 * * * *', {}, { tz: 'UTC' }); // plus the fast loop below
  await boss.schedule(QUEUES.recurringTick, '*/15 * * * *', {}, { tz: 'UTC' });
  await boss.schedule(QUEUES.bankSyncTick, '7,22,37,52 * * * *', {}, { tz: 'UTC' });
  await boss.schedule(QUEUES.maintenance, '17 * * * *', {}, { tz: 'UTC' });
}
