import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import type { ClosePeriodInput, PeriodDto, ReopenPeriodInput } from '@evenbooks/contracts';
import { ServiceError, notFound, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';

type PeriodRow = typeof schema.accountingPeriods.$inferSelect;

function toDto(p: PeriodRow): PeriodDto {
  return {
    id: p.id,
    startDate: p.startDate,
    endDate: p.endDate,
    status: p.status,
    closedAt: p.closedAt,
    closedBy: p.closedBy,
    reopenedAt: p.reopenedAt,
    reopenedBy: p.reopenedBy,
    reason: p.reason,
    version: p.version,
  };
}

export async function listPeriods(s: ServiceContext): Promise<PeriodDto[]> {
  const rows = await s.tx
    .select()
    .from(schema.accountingPeriods)
    .where(eq(schema.accountingPeriods.companyId, s.ctx.companyId))
    .orderBy(asc(schema.accountingPeriods.startDate));
  return rows.map(toDto);
}

/** Close a date range. Drafts dated inside the range remain drafts and cannot be posted until reopened. */
export async function closePeriod(s: ServiceContext, input: ClosePeriodInput): Promise<PeriodDto> {
  const [row] = await s.tx
    .insert(schema.accountingPeriods)
    .values({
      companyId: s.ctx.companyId,
      startDate: input.startDate,
      endDate: input.endDate,
      status: 'closed',
      closedAt: new Date().toISOString(),
      closedBy: s.ctx.actorId,
      reason: input.reason ?? null,
    })
    .returning();
  await recordAudit(s, {
    action: 'period.closed',
    entityType: 'accounting_period',
    entityId: row!.id,
    reason: input.reason ?? null,
    details: { startDate: input.startDate, endDate: input.endDate },
  });
  return toDto(row!);
}

export async function reopenPeriod(s: ServiceContext, id: string, input: ReopenPeriodInput): Promise<PeriodDto> {
  const [existing] = await s.tx
    .select()
    .from(schema.accountingPeriods)
    .where(and(eq(schema.accountingPeriods.companyId, s.ctx.companyId), eq(schema.accountingPeriods.id, id)));
  if (!existing) throw notFound('Accounting period');
  if (existing.status === 'open') throw new ServiceError('invalid_state', 'Period is already open');
  const [row] = await s.tx
    .update(schema.accountingPeriods)
    .set({ status: 'open', reopenedAt: new Date().toISOString(), reopenedBy: s.ctx.actorId, reason: input.reason })
    .where(and(eq(schema.accountingPeriods.id, id), eq(schema.accountingPeriods.version, input.version)))
    .returning();
  if (!row) throw versionConflict('Accounting period');
  await recordAudit(s, { action: 'period.reopened', entityType: 'accounting_period', entityId: id, reason: input.reason });
  return toDto(row);
}

export async function recloseperiod(s: ServiceContext, id: string, version: number, reason?: string): Promise<PeriodDto> {
  const [row] = await s.tx
    .update(schema.accountingPeriods)
    .set({ status: 'closed', closedAt: new Date().toISOString(), closedBy: s.ctx.actorId, reason: reason ?? null })
    .where(and(eq(schema.accountingPeriods.companyId, s.ctx.companyId), eq(schema.accountingPeriods.id, id), eq(schema.accountingPeriods.version, version)))
    .returning();
  if (!row) throw versionConflict('Accounting period');
  await recordAudit(s, { action: 'period.closed', entityType: 'accounting_period', entityId: id, reason: reason ?? null });
  return toDto(row);
}
