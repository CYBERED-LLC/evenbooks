import { schema } from '@evenbooks/db';
import type { ServiceContext } from './context';

/**
 * Transactional outbox. Rows commit with the financial change; the worker
 * dispatcher (system context) turns them into durable jobs. Dispatch is
 * at-least-once, so consumers must be idempotent on `dedupeKey`.
 */
export async function enqueueOutbox(s: ServiceContext, eventType: string, payload: Record<string, unknown>, dedupeKey: string): Promise<boolean> {
  const inserted = await s.tx
    .insert(schema.outboxEvents)
    .values({ companyId: s.ctx.companyId, eventType, payload: { ...payload, companyId: s.ctx.companyId, actorId: s.ctx.actorId }, dedupeKey })
    .onConflictDoNothing({ target: schema.outboxEvents.dedupeKey })
    .returning({ id: schema.outboxEvents.id });
  // false = an event with this dedupe key already exists (nothing was added)
  return inserted.length > 0;
}
