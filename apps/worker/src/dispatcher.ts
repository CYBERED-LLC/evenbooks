import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { withSystem, type Db } from '@evenbooks/db';
import { JOB_RETRY_EVENT, RETRYABLE_QUEUES } from '@evenbooks/services';
import { QUEUES } from './queues';
import { logger } from './logger';

type OutboxRow = {
  id: string;
  company_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  dedupe_key: string;
  attempts: number;
};

/**
 * Outbox dispatcher: turns committed outbox rows into durable jobs. Runs often
 * (every 10s) and tolerates repeats: `singletonKey = dedupe_key` makes pg-boss
 * drop duplicates while a job with the same key is still queued/active, and
 * the consumers are idempotent anyway. Rows are marked dispatched only after
 * the enqueue succeeds; a crash in between simply re-dispatches.
 */
export async function dispatchOutbox(db: Db, boss: PgBoss, batch = 200): Promise<number> {
  const rows = await withSystem(db, async (tx) => {
    const res = await tx.execute<OutboxRow>(sql`
      select id::text as id, company_id, event_type, payload, dedupe_key, attempts
        from outbox_events
       where dispatched_at is null
       order by id
       limit ${batch}
       for update skip locked`);
    return res.rows;
  });
  let dispatched = 0;
  for (const row of rows) {
    const retry = row.event_type === JOB_RETRY_EVENT ? retryTarget(row) : null;
    const queue = retry ? retry.queue : queueFor(row.event_type);
    try {
      if (retry) {
        await boss.send(retry.queue, retry.data, { singletonKey: retry.singletonKey });
      } else if (queue) {
        await boss.send(queue, { ...row.payload, companyId: row.company_id, outboxId: row.id }, { singletonKey: row.dedupe_key, id: undefined });
      } else {
        logger.warn({ eventType: row.event_type, outboxId: row.id }, 'no consumer for outbox event; marking dispatched');
      }
      await withSystem(db, (tx) => tx.execute(sql`update outbox_events set dispatched_at = now(), attempts = attempts + 1 where id = ${row.id}::bigint`));
      dispatched++;
    } catch (err) {
      logger.error({ err, outboxId: row.id }, 'outbox dispatch failed');
      await withSystem(db, (tx) => tx.execute(sql`update outbox_events set attempts = attempts + 1, last_error = ${(err as Error).message} where id = ${row.id}::bigint`)).catch(() => {});
    }
  }
  return dispatched;
}

/**
 * A retry requested from /settings/jobs: re-send the failed job's payload to its
 * own queue (allow-listed, company pinned to the outbox row). The original
 * singleton key keeps pg-boss's per-record dedupe, e.g. one sync per connection.
 */
function retryTarget(row: OutboxRow): { queue: string; data: Record<string, unknown>; singletonKey: string } | null {
  const { queue, data, singletonKey, retryOfJobId } = row.payload as { queue?: unknown; data?: unknown; singletonKey?: unknown; retryOfJobId?: unknown };
  if (typeof queue !== 'string' || !(RETRYABLE_QUEUES as readonly string[]).includes(queue) || typeof data !== 'object' || data === null) return null;
  return {
    queue,
    data: { ...(data as Record<string, unknown>), companyId: row.company_id, outboxId: row.id, retryOfJobId },
    singletonKey: typeof singletonKey === 'string' && singletonKey ? singletonKey : row.dedupe_key,
  };
}

function queueFor(eventType: string): string | null {
  switch (eventType) {
    case 'invoice.issued':
      return QUEUES.invoiceIssued;
    case 'email.send':
      return QUEUES.emailSend;
    default:
      return null;
  }
}
