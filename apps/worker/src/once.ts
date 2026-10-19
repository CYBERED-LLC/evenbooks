import { sql } from 'drizzle-orm';
import { withSystem, type Db } from '@evenbooks/db';
import { cleanupOrphanAttachments, refreshActiveEmailSenders, dueConnections, dueSchedules, markStuckSendsUncertain, retryProcessorEvents, settlePendingChargeFees } from '@evenbooks/services';
import { registerJobs, type WorkerDeps } from './jobs';
import { QUEUES, type BankSyncJob, type RecurringIssueJob } from './queues';
import { dispatchOutbox } from './dispatcher';
import { logger } from './logger';

export interface RunOnceOptions {
  /** Stop draining after this long even if runnable jobs remain; they wait for the next run. */
  maxMs?: number;
  /** Pollers per queue while draining (WORKER_CONCURRENCY in production). */
  concurrency?: number;
  /** How often to re-check the outbox and queue depth while draining. */
  pollMs?: number;
  now?: () => Date;
}

export interface RunOnceResult {
  dispatched: number;
  recurringDue: number;
  bankSyncDue: number;
  maintenance: { senderChecks: number; orphans: number; uncertain: number; processorRetries: { retried: number; processed: number } };
  /** Runnable or active jobs left behind when the time budget ran out. */
  remaining: number;
  ms: number;
}

/** Queues whose jobs a single run must finish before it exits. */
const DRAIN_QUEUES = [QUEUES.invoiceIssued, QUEUES.emailSend, QUEUES.recurringIssue, QUEUES.bankSync];

/**
 * One complete pass of the worker's duties, for a scheduled (cron) process:
 * dispatch the outbox, fan out due recurring schedules and bank connections,
 * run maintenance, then work every runnable job until the queues are empty
 * or the time budget is spent. Failed jobs keep pg-boss's retry/dead-letter
 * semantics; a retry whose delay has not elapsed is picked up by a later run.
 *
 * Safe to run alongside a long-running worker (all consumers are idempotent
 * and the queues are singleton-keyed), and safe to interrupt: the outbox and
 * queue are durable, so nothing is lost if the process is stopped early.
 */
export async function runOnce(deps: WorkerDeps, opts: RunOnceOptions = {}): Promise<RunOnceResult> {
  const { db, boss } = deps;
  const maxMs = opts.maxMs ?? 4 * 60_000;
  const pollMs = opts.pollMs ?? 500;
  const now = opts.now ?? (() => new Date());
  const started = Date.now();

  await heartbeat(db);
  // Expire, archive and retry-schedule as the daemon's supervisor would.
  await boss.supervise().catch((err) => logger.warn({ err }, 'pg-boss maintenance failed'));

  let dispatched = await dispatchOutbox(db, boss);

  const recurring = await dueSchedules(db, now());
  for (const s of recurring) {
    await boss.send(QUEUES.recurringIssue, { companyId: s.companyId, scheduleId: s.id } satisfies RecurringIssueJob, { singletonKey: `recurring:${s.id}` });
  }
  const connections = await dueConnections(db, now());
  for (const c of connections) {
    await boss.send(QUEUES.bankSync, { companyId: c.companyId, connectionId: c.id } satisfies BankSyncJob, { singletonKey: `bank-sync:${c.id}` });
  }
  const maintenance = {
    senderChecks: deps.identities ? await refreshActiveEmailSenders(db, deps.identities) : 0,
    orphans: await cleanupOrphanAttachments(db, deps.storage, now()).catch((err) => (logger.error({ err }, 'orphan cleanup failed'), 0)),
    uncertain: await markStuckSendsUncertain(db).catch((err) => (logger.error({ err }, 'stuck-send check failed'), 0)),
    processorRetries: await retryProcessorEvents(db, { client: deps.processor, feeConfig: deps.feeConfig }).catch((err) => (logger.error({ err }, 'processor event retry failed'), { retried: 0, processed: 0 })),
    chargeFees: await settlePendingChargeFees(db, { client: deps.processor, feeConfig: deps.feeConfig }).catch((err) => (logger.error({ err }, 'pending charge fee sweep failed'), { checked: 0, settled: 0 })),
  };

  // Work the queues until nothing runnable is left. Issuance and sync jobs
  // write outbox rows (invoice.issued → PDF/email), so keep dispatching too.
  registerJobs(deps, { pollingIntervalSeconds: 0.5, localConcurrency: Math.max(1, opts.concurrency ?? 1) });
  let remaining = await runnableJobs(db);
  while (Date.now() - started < maxMs) {
    dispatched += await dispatchOutbox(db, boss);
    remaining = await runnableJobs(db);
    if (remaining === 0) {
      // Give in-flight handlers a moment to enqueue follow-ups, then confirm.
      await sleep(pollMs);
      dispatched += await dispatchOutbox(db, boss);
      remaining = await runnableJobs(db);
      if (remaining === 0) break;
    }
    await sleep(pollMs);
  }
  if (remaining > 0) logger.warn({ remaining, maxMs }, 'time budget spent with jobs still runnable; the next run continues');

  await heartbeat(db);
  const result = { dispatched, recurringDue: recurring.length, bankSyncDue: connections.length, maintenance, remaining, ms: Date.now() - started };
  logger.info(result, 'run complete');
  return result;
}

/** Jobs that are active now or ready to be fetched (created/retry with start_after reached). */
async function runnableJobs(db: Db): Promise<number> {
  return withSystem(db, async (tx) => {
    const res = await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from pgboss.job
       where name in (${sql.join(DRAIN_QUEUES.map((q) => sql`${q}`), sql`, `)})
         and (state = 'active' or (state in ('created', 'retry') and start_after <= now()))`);
    return Number(res.rows[0]?.n ?? 0);
  });
}

async function heartbeat(db: Db): Promise<void> {
  await withSystem(db, (tx) =>
    tx.execute(sql`insert into worker_heartbeat (id, at) values (1, now()) on conflict (id) do update set at = excluded.at`),
  ).catch(() => {});
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

