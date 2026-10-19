import { sql } from 'drizzle-orm';
import type { FailedJobRetryDto, JobStatusDto } from '@evenbooks/contracts';
import type { ServiceContext } from './context';
import { ServiceError, notFound } from './errors';
import { enqueueOutbox } from './outbox';
import { recordAudit } from './audit';

/** A retry requested from the jobs page for one failed job (the outbox row that carries it). */
export type FailedJobRetry = FailedJobRetryDto;
/** `jobStatus` includes, per failed job, whether it can be retried and any retry already requested. */
export type JobStatusWithRetries = JobStatusDto;

/**
 * Queues whose failed jobs an admin may re-run. Each consumer is idempotent on
 * its own record (see `retryFailedJob`); the ticks and maintenance are not
 * company jobs and simply run again on schedule.
 */
export const RETRYABLE_QUEUES = ['invoice.issued', 'email.send', 'recurring.issue', 'bank.sync'] as const;
export type RetryableQueue = (typeof RETRYABLE_QUEUES)[number];
const isRetryable = (name: string): name is RetryableQueue => (RETRYABLE_QUEUES as readonly string[]).includes(name);
/** Outbox event type the worker dispatcher maps back onto the original queue. */
export const JOB_RETRY_EVENT = 'job.retry';
export const jobRetryDedupeKey = (jobId: string) => `${JOB_RETRY_EVENT}:${jobId}`;

/**
 * Operational visibility for one company: queue depth, dead jobs that belong to
 * the company, outbox backlog, stale bank syncs and email delivery problems.
 * pg-boss tables live in the `pgboss` schema; job payloads carry companyId.
 */
export async function jobStatus(s: ServiceContext): Promise<JobStatusWithRetries> {
  const companyId = s.ctx.companyId;
  const hasBoss = await s.tx.execute<{ ok: boolean }>(sql`select exists (select 1 from information_schema.tables where table_schema = 'pgboss' and table_name = 'job') as ok`);
  let queues: JobStatusDto['queues'] = [];
  let failedJobs: JobStatusWithRetries['failedJobs'] = [];
  if (hasBoss.rows[0]?.ok) {
    const q = await s.tx.execute<{ name: string; state: string; n: string }>(sql`
      select name, state::text as state, count(*)::text as n from pgboss.job
       where data->>'companyId' = ${companyId} or name in ('recurring.tick','bank.sync.tick','maintenance','outbox.dispatch')
       group by name, state`);
    const byName = new Map<string, JobStatusDto['queues'][number]>();
    for (const r of q.rows) {
      const entry = byName.get(r.name) ?? { name: r.name, created: 0, active: 0, retry: 0, failed: 0, completed: 0 };
      const key = r.state as keyof typeof entry;
      if (key in entry && key !== 'name') (entry as unknown as Record<string, number>)[key] = Number(r.n);
      byName.set(r.name, entry);
    }
    queues = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    const f = await s.tx.execute<{ id: string; name: string; created_on: string; completed_on: string | null; retry_count: number; output: unknown; data: unknown; retry_requested_at: string | null; retry_dispatched_at: string | null }>(sql`
      select j.id::text, j.name, j.created_on, j.completed_on, j.retry_count, j.output, j.data,
             o.created_at as retry_requested_at, o.dispatched_at as retry_dispatched_at
        from pgboss.job j
        left join outbox_events o on o.company_id = ${companyId} and o.dedupe_key = ${JOB_RETRY_EVENT + ':'} || j.id::text
       where j.state = 'failed' and (j.data->>'companyId' = ${companyId})
       order by j.created_on desc limit 50`);
    failedJobs = f.rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdOn: new Date(r.created_on).toISOString(),
      completedOn: r.completed_on ? new Date(r.completed_on).toISOString() : null,
      retryCount: r.retry_count,
      output: r.output,
      data: r.data,
      retryable: isRetryable(r.name),
      retry: r.retry_requested_at ? { requestedAt: new Date(r.retry_requested_at).toISOString(), dispatchedAt: r.retry_dispatched_at ? new Date(r.retry_dispatched_at).toISOString() : null } : null,
    }));
  }
  const outbox = await s.tx.execute<{ n: string; oldest: string | null }>(sql`
    select count(*)::text as n, extract(epoch from now() - min(created_at))::text as oldest
      from outbox_events where company_id = ${companyId} and dispatched_at is null`);
  const stale = await s.tx.execute<{ id: string; name: string; last_success_at: string | null; last_error: string | null }>(sql`
    select id, name, last_success_at, last_error from bank_connections
     where company_id = ${companyId} and status in ('active','error')
       and (last_success_at is null or last_success_at < now() - (sync_interval_minutes * 2 || ' minutes')::interval)`);
  const emails = await s.tx.execute<{ id: string; invoice_id: string | null; to_email: string; status: string; last_error: string | null; queued_at: string }>(sql`
    select id, invoice_id, to_email, status, last_error, queued_at from email_messages
     where company_id = ${companyId} and status in ('failed','bounced','complained','uncertain','suppressed')
     order by queued_at desc limit 50`);
  const processor = await s.tx.execute<{ id: number; event_type: string; received_at: string; attempts: number; last_error: string | null }>(sql`
    select id, event_type, received_at, attempts, last_error from processor_events
     where company_id = ${companyId} and processed_at is null and last_error is not null
     order by received_at desc limit 50`);
  const hb = await s.tx.execute<{ at: string }>(sql`select at from worker_heartbeat where id = 1`).catch(() => ({ rows: [] as { at: string }[] }));
  return {
    queues,
    failedJobs,
    outboxPending: Number(outbox.rows[0]?.n ?? 0),
    outboxOldestAgeSeconds: outbox.rows[0]?.oldest ? Math.round(Number(outbox.rows[0].oldest)) : null,
    staleConnections: stale.rows.map((r) => ({ id: r.id, name: r.name, lastSuccessAt: r.last_success_at, lastError: r.last_error })),
    emailProblems: emails.rows.map((r) => ({ id: r.id, invoiceId: r.invoice_id, toEmail: r.to_email, status: r.status, lastError: r.last_error, queuedAt: r.queued_at })),
    workerHeartbeatAt: hb.rows[0]?.at ? new Date(hb.rows[0].at).toISOString() : null,
    processorEventProblems: processor.rows.map((r) => ({ id: Number(r.id), eventType: r.event_type, receivedAt: new Date(r.received_at).toISOString(), attempts: r.attempts, lastError: r.last_error })),
  };
}

export interface RetryJobResult {
  jobId: string;
  queue: RetryableQueue;
  /** `already_requested`: a retry for this failed job exists; nothing new was queued. */
  status: 'queued' | 'already_requested';
  retry: FailedJobRetry;
}

/**
 * Re-run one failed job of this company. The request is written to the
 * transactional outbox (dedupe key per failed job, so repeated clicks queue it
 * once) and the worker's dispatcher sends a fresh job to the original queue
 * with the original payload, exactly as it dispatches every other event.
 *
 * Safety comes from the consumers, which are idempotent on their own records;
 * the checks below refuse the cases where a re-run could do harm or cannot help:
 * - email.send: the send claims the message atomically (`queued` -> `sending`)
 *   and is a no-op for any other state, so a sent message is never re-sent. An
 *   `uncertain` message would be claimed again, so it is refused here: check the
 *   provider, then use Resend. `failed`/bounced messages need Resend (a new message).
 * - recurring.issue: one invoice per (schedule, occurrence) under a unique index.
 * - invoice.issued: the PDF is generated once under a per-invoice lock.
 * - bank.sync: throttled and upserted by provider transaction id.
 */
export async function retryFailedJob(s: ServiceContext, jobId: string): Promise<RetryJobResult> {
  const companyId = s.ctx.companyId;
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw notFound('Failed job');
  const hasBoss = await s.tx.execute<{ ok: boolean }>(sql`select exists (select 1 from information_schema.tables where table_schema = 'pgboss' and table_name = 'job') as ok`);
  if (!hasBoss.rows[0]?.ok) throw notFound('Failed job');
  const found = await s.tx.execute<{ id: string; name: string; data: Record<string, unknown> | null; singleton_key: string | null }>(sql`
    select id::text, name, data, singleton_key from pgboss.job
     where id = ${jobId}::uuid and state = 'failed' and data->>'companyId' = ${companyId}`);
  const job = found.rows[0];
  if (!job) throw notFound('Failed job');
  if (!isRetryable(job.name)) throw new ServiceError('validation', `${job.name} jobs cannot be retried from here; they run again on their own schedule`);
  const data = job.data ?? {};

  const dedupeKey = jobRetryDedupeKey(jobId);
  const existing = await findRetry(s, dedupeKey);
  if (existing) return { jobId, queue: job.name, status: 'already_requested', retry: existing };

  const source = await assertRetrySafe(s, job.name, data);
  // Drop dispatcher bookkeeping from the original payload; the dispatcher adds its own.
  const { outboxId: _outboxId, actorId: _actorId, retryOfJobId: _prev, ...payload } = data;
  const inserted = await enqueueOutbox(s, JOB_RETRY_EVENT, { queue: job.name, data: { ...payload, companyId }, singletonKey: job.singleton_key, retryOfJobId: jobId }, dedupeKey);
  const retry = (await findRetry(s, dedupeKey))!;
  if (!inserted) return { jobId, queue: job.name, status: 'already_requested', retry };
  await recordAudit(s, { action: 'job.retry_requested', entityType: 'job', entityId: jobId, details: { queue: job.name, ...source } });
  return { jobId, queue: job.name, status: 'queued', retry };
}

async function findRetry(s: ServiceContext, dedupeKey: string): Promise<FailedJobRetry | null> {
  const r = await s.tx.execute<{ created_at: string; dispatched_at: string | null }>(sql`
    select created_at, dispatched_at from outbox_events where company_id = ${s.ctx.companyId} and dedupe_key = ${dedupeKey}`);
  const row = r.rows[0];
  return row ? { requestedAt: new Date(row.created_at).toISOString(), dispatchedAt: row.dispatched_at ? new Date(row.dispatched_at).toISOString() : null } : null;
}

const refuse = (message: string) => new ServiceError('invalid_state', message);
const idOf = (data: Record<string, unknown>, key: string): string => {
  const v = data[key];
  if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/i.test(v)) throw new ServiceError('validation', `The job payload has no ${key}; it cannot be retried`);
  return v;
};

/** Per-queue guard; returns the source record for the audit trail. */
async function assertRetrySafe(s: ServiceContext, queue: RetryableQueue, data: Record<string, unknown>): Promise<Record<string, string>> {
  const companyId = s.ctx.companyId;
  switch (queue) {
    case 'email.send': {
      const id = idOf(data, 'emailMessageId');
      const r = await s.tx.execute<{ status: string; invoice_id: string | null }>(sql`select status, invoice_id from email_messages where id = ${id} and company_id = ${companyId}`);
      const m = r.rows[0];
      if (!m) throw notFound('Email message');
      if (m.status === 'sent') throw refuse('This email was already sent; retrying would not send it again.');
      if (m.status === 'sending') throw refuse('This email is being sent right now. Refresh in a minute.');
      if (m.status === 'uncertain') throw refuse('Delivery of this email is uncertain: it may have reached the customer. Check the email provider, then use Resend on the invoice if it did not arrive.');
      if (m.status !== 'queued') throw refuse(`This email ${m.status === 'failed' ? 'failed permanently' : `was ${m.status}`}. Fix the address if needed and use Resend on the invoice.`);
      return { emailMessageId: id, ...(m.invoice_id && { invoiceId: m.invoice_id }) };
    }
    case 'invoice.issued': {
      const id = idOf(data, 'invoiceId');
      const r = await s.tx.execute<{ status: string }>(sql`select status::text as status from invoices where id = ${id} and company_id = ${companyId}`);
      if (!r.rows[0]) throw notFound('Invoice');
      if (r.rows[0].status === 'draft') throw refuse('The invoice is a draft again; its PDF is made when it is issued.');
      return { invoiceId: id };
    }
    case 'recurring.issue': {
      const id = idOf(data, 'scheduleId');
      const r = await s.tx.execute<{ status: string }>(sql`select status from recurring_schedules where id = ${id} and company_id = ${companyId}`);
      if (!r.rows[0]) throw notFound('Recurring schedule');
      if (r.rows[0].status !== 'active') throw refuse(`The schedule is ${r.rows[0].status}; resume it to issue its due invoices.`);
      return { scheduleId: id };
    }
    case 'bank.sync': {
      const id = idOf(data, 'connectionId');
      const r = await s.tx.execute<{ status: string }>(sql`select status from bank_connections where id = ${id} and company_id = ${companyId}`);
      if (!r.rows[0]) throw notFound('Bank connection');
      if (r.rows[0].status !== 'active') throw refuse(`The bank connection is ${r.rows[0].status}; reconnect it on the Banking page first.`);
      return { connectionId: id };
    }
  }
}
