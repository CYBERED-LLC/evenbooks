import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import type { AuditEventDto } from '@evenbooks/contracts';
import type { ServiceContext } from './context';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  details?: Record<string, unknown>;
}

/** Append an audit event in the current transaction. Never include secrets in details. */
export async function recordAudit(s: ServiceContext, input: AuditInput): Promise<void> {
  await s.tx.insert(schema.auditEvents).values({
    companyId: s.ctx.companyId,
    actorType: s.ctx.actorType,
    actorId: s.ctx.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    reason: input.reason ?? null,
    details: input.details ?? {},
    requestId: s.ctx.requestId ?? null,
    jobId: s.ctx.jobId ?? null,
  });
}

export async function listAudit(
  s: ServiceContext,
  q: { limit: number; cursor?: string; entityType?: string; entityId?: string; from?: string; to?: string },
): Promise<{ items: AuditEventDto[]; nextCursor: string | null }> {
  const conds = [eq(schema.auditEvents.companyId, s.ctx.companyId)];
  if (q.entityType) conds.push(eq(schema.auditEvents.entityType, q.entityType));
  if (q.entityId) conds.push(eq(schema.auditEvents.entityId, q.entityId));
  if (q.cursor) conds.push(lt(schema.auditEvents.id, Number(q.cursor)));
  if (q.from || q.to) {
    // Dates are calendar days in the company's time zone, both ends inclusive.
    const localDay = sql`(${schema.auditEvents.createdAt} at time zone (select ${schema.companies.timeZone} from ${schema.companies} where ${schema.companies.id} = ${s.ctx.companyId}))::date`;
    if (q.from) conds.push(sql`${localDay} >= ${q.from}::date`);
    if (q.to) conds.push(sql`${localDay} <= ${q.to}::date`);
  }
  const rows = await s.tx
    .select()
    .from(schema.auditEvents)
    .where(and(...conds))
    .orderBy(desc(schema.auditEvents.id))
    .limit(q.limit + 1);
  const items = rows.slice(0, q.limit).map((r) => ({
    id: r.id,
    actorType: r.actorType,
    actorId: r.actorId,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    reason: r.reason,
    details: r.details,
    requestId: r.requestId,
    jobId: r.jobId,
    createdAt: r.createdAt,
  }));
  return { items, nextCursor: rows.length > q.limit ? String(items[items.length - 1]!.id) : null };
}
