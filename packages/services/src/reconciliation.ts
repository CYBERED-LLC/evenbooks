import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import type { ReconciliationDetailDto, ReconciliationDto, ReconciliationLineDto, StartReconciliationInput } from '@evenbooks/contracts';
import { ServiceError, notFound, plainDate, plainMoney, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { getBankAccount } from './bank-accounts';

type SessionRow = typeof schema.reconciliationSessions.$inferSelect;

function toDto(r: SessionRow, bankAccountName?: string): ReconciliationDto {
  const cur = 'USD';
  return {
    id: r.id,
    bankAccountId: r.bankAccountId,
    bankAccountName,
    statementStartDate: r.statementStartDate,
    statementEndDate: r.statementEndDate,
    statementOpeningBalance: Money.round(r.statementOpeningBalance, cur).toString(),
    statementClosingBalance: Money.round(r.statementClosingBalance, cur).toString(),
    status: r.status,
    clearedBalance: r.clearedBalance ? Money.round(r.clearedBalance, cur).toString() : null,
    discrepancy: r.discrepancy ? Money.round(r.discrepancy, cur).toString() : null,
    completedAt: r.completedAt,
    completedBy: r.completedBy,
    flaggedReason: r.flaggedReason,
    notes: r.notes,
    version: r.version,
    createdAt: r.createdAt,
  };
}

export async function listReconciliations(s: ServiceContext, bankAccountId?: string): Promise<ReconciliationDto[]> {
  const conds = [eq(schema.reconciliationSessions.companyId, s.ctx.companyId)];
  if (bankAccountId) conds.push(eq(schema.reconciliationSessions.bankAccountId, bankAccountId));
  const rows = await s.tx
    .select({ r: schema.reconciliationSessions, name: schema.bankAccounts.name })
    .from(schema.reconciliationSessions)
    .innerJoin(schema.bankAccounts, eq(schema.bankAccounts.id, schema.reconciliationSessions.bankAccountId))
    .where(and(...conds))
    .orderBy(desc(schema.reconciliationSessions.statementEndDate));
  return rows.map(({ r, name }) => toDto(r, name));
}

export async function startReconciliation(s: ServiceContext, input: StartReconciliationInput): Promise<ReconciliationDetailDto> {
  const ba = await getBankAccount(s, input.bankAccountId);
  const cur = ba.currency;
  const [open] = await s.tx
    .select({ id: schema.reconciliationSessions.id })
    .from(schema.reconciliationSessions)
    .where(and(eq(schema.reconciliationSessions.companyId, s.ctx.companyId), eq(schema.reconciliationSessions.bankAccountId, ba.id), eq(schema.reconciliationSessions.status, 'in_progress')));
  if (open) throw new ServiceError('invalid_state', 'A reconciliation is already in progress for this account. Finish or delete it before starting another.');
  const [row] = await s.tx
    .insert(schema.reconciliationSessions)
    .values({
      companyId: s.ctx.companyId,
      bankAccountId: ba.id,
      statementStartDate: input.statementStartDate,
      statementEndDate: input.statementEndDate,
      statementOpeningBalance: Money.of(input.statementOpeningBalance, cur).toString(),
      statementClosingBalance: Money.of(input.statementClosingBalance, cur).toString(),
      notes: input.notes ?? null,
      createdBy: s.ctx.actorId,
    })
    .returning();
  await recordAudit(s, { action: 'reconciliation.started', entityType: 'reconciliation', entityId: row!.id, details: { bankAccountId: ba.id, end: input.statementEndDate } });
  return getReconciliation(s, row!.id);
}

async function loadSession(s: ServiceContext, id: string): Promise<SessionRow> {
  const [row] = await s.tx
    .select()
    .from(schema.reconciliationSessions)
    .where(and(eq(schema.reconciliationSessions.companyId, s.ctx.companyId), eq(schema.reconciliationSessions.id, id)))
    .limit(1);
  if (!row) throw notFound('Reconciliation');
  return row;
}

/**
 * Candidate lines: posted journal lines on the bank ledger account dated on or
 * before the statement end, not cleared by another completed session.
 * Lines dated before the statement start appear too (late-clearing items).
 */
async function loadLines(s: ServiceContext, session: SessionRow, ledgerAccountId: string, isLiability: boolean, cur: string): Promise<ReconciliationLineDto[]> {
  const rows = await s.tx
    .select({
      lineId: schema.journalLines.id,
      entryId: schema.journalEntries.id,
      entryNumber: schema.journalEntries.entryNumber,
      date: schema.journalEntries.date,
      memo: schema.journalEntries.memo,
      sourceType: schema.journalEntries.sourceType,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(eq(schema.journalLines.companyId, s.ctx.companyId), eq(schema.journalLines.accountId, ledgerAccountId), eq(schema.journalEntries.status, 'posted'), lte(schema.journalEntries.date, session.statementEndDate)))
    .orderBy(asc(schema.journalEntries.date), asc(schema.journalEntries.entryNumber));
  const clearedElsewhere = await s.tx
    .select({ lineId: schema.reconciliationItems.journalLineId })
    .from(schema.reconciliationItems)
    .innerJoin(schema.reconciliationSessions, eq(schema.reconciliationSessions.id, schema.reconciliationItems.sessionId))
    .where(and(eq(schema.reconciliationItems.companyId, s.ctx.companyId), inArray(schema.reconciliationSessions.status, ['completed', 'flagged']), sql`${schema.reconciliationSessions.id} <> ${session.id}`));
  const excluded = new Set(clearedElsewhere.map((c) => c.lineId));
  const mine = await s.tx.select({ lineId: schema.reconciliationItems.journalLineId }).from(schema.reconciliationItems).where(eq(schema.reconciliationItems.sessionId, session.id));
  const cleared = new Set(mine.map((m) => m.lineId));
  return rows
    .filter((r) => !excluded.has(r.lineId))
    .map((r) => {
      const d = Money.round(r.debit, cur);
      const c = Money.round(r.credit, cur);
      // statement balance for a credit card is the amount owed (liability grows with credits)
      const effect = isLiability ? c.subtract(d) : d.subtract(c);
      return {
        journalLineId: r.lineId,
        entryId: r.entryId,
        entryNumber: r.entryNumber,
        date: r.date,
        memo: r.memo,
        amount: effect.toString(),
        cleared: cleared.has(r.lineId),
        sourceType: r.sourceType,
      };
    });
}

export async function getReconciliation(s: ServiceContext, id: string): Promise<ReconciliationDetailDto> {
  const session = await loadSession(s, id);
  const ba = await getBankAccount(s, session.bankAccountId);
  const cur = ba.currency;
  const isLiability = ba.kind === 'credit_card';
  const lines = await loadLines(s, session, ba.ledgerAccountId, isLiability, cur);
  const clearedSum = Money.sum(lines.filter((l) => l.cleared).map((l) => Money.of(l.amount, cur)), cur);
  const opening = Money.round(session.statementOpeningBalance, cur);
  const closing = Money.round(session.statementClosingBalance, cur);
  const clearedBalance = opening.add(clearedSum);
  const discrepancy = closing.subtract(clearedBalance);
  const ledgerAtEnd = Money.sum(lines.map((l) => Money.of(l.amount, cur)), cur);
  return {
    ...toDto(session, ba.name),
    lines,
    clearedBalance: clearedBalance.toString(),
    discrepancy: discrepancy.toString(),
    ledgerBalanceAtEnd: ledgerAtEnd.toString(),
  };
}

export async function toggleReconciliationItems(s: ServiceContext, id: string, input: { version: number; clear: string[]; unclear: string[] }): Promise<ReconciliationDetailDto> {
  const session = await loadSession(s, id);
  if (session.version !== input.version) throw versionConflict('Reconciliation');
  if (session.status !== 'in_progress') throw new ServiceError('invalid_state', 'Reconciliation is not in progress');
  const ba = await getBankAccount(s, session.bankAccountId);
  if (input.unclear.length) {
    await s.tx.delete(schema.reconciliationItems).where(and(eq(schema.reconciliationItems.sessionId, id), inArray(schema.reconciliationItems.journalLineId, input.unclear)));
  }
  if (input.clear.length) {
    const lines = await s.tx
      .select({ id: schema.journalLines.id, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
      .from(schema.journalLines)
      .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
      .where(and(eq(schema.journalLines.companyId, s.ctx.companyId), eq(schema.journalLines.accountId, ba.ledgerAccountId), eq(schema.journalEntries.status, 'posted'), inArray(schema.journalLines.id, input.clear), lte(schema.journalEntries.date, session.statementEndDate)));
    if (lines.length !== new Set(input.clear).size) throw new ServiceError('validation', `Some of those transactions aren’t on this account or are dated after ${plainDate(session.statementEndDate)}. Reload the page and try again.`);
    const already = await s.tx.select({ lineId: schema.reconciliationItems.journalLineId }).from(schema.reconciliationItems).where(and(eq(schema.reconciliationItems.sessionId, id), inArray(schema.reconciliationItems.journalLineId, input.clear)));
    const have = new Set(already.map((a) => a.lineId));
    const isLiability = ba.kind === 'credit_card';
    const toInsert = lines.filter((l) => !have.has(l.id));
    if (toInsert.length) {
      await s.tx.insert(schema.reconciliationItems).values(
        toInsert.map((l) => {
          const d = Money.round(l.debit, ba.currency);
          const c = Money.round(l.credit, ba.currency);
          return { companyId: s.ctx.companyId, sessionId: id, journalLineId: l.id, amount: (isLiability ? c.subtract(d) : d.subtract(c)).toString() };
        }),
      );
    }
  }
  await s.tx.update(schema.reconciliationSessions).set({ version: session.version + 1 }).where(eq(schema.reconciliationSessions.id, id));
  return getReconciliation(s, id);
}

/** Complete only when the statement closing balance equals opening + cleared items. */
export async function completeReconciliation(s: ServiceContext, id: string, input: { version: number; idempotencyKey?: string }): Promise<ReconciliationDetailDto> {
  return idempotent(s, input.idempotencyKey, { id, version: input.version }, async () => {
    const detail = await getReconciliation(s, id);
    if (detail.status === 'completed') return detail;
    if (detail.version !== input.version) throw versionConflict('Reconciliation');
    if (detail.status !== 'in_progress') throw new ServiceError('invalid_state', 'Reconciliation is not in progress');
    if (!Money.of(detail.discrepancy, 'USD').isZero()) {
      throw new ServiceError('validation', `${plainMoney(Money.of(detail.discrepancy, s.company.baseCurrency).abs(), s.company.baseCurrency)} is still to explain, so this can't be completed yet. Tick the transactions on your statement, add any that are missing, or check the statement balances.`);
    }
    const [row] = await s.tx
      .update(schema.reconciliationSessions)
      .set({ status: 'completed', clearedBalance: detail.clearedBalance, discrepancy: '0', completedAt: new Date().toISOString(), completedBy: s.ctx.actorId })
      .where(and(eq(schema.reconciliationSessions.id, id), eq(schema.reconciliationSessions.version, input.version)))
      .returning();
    if (!row) throw versionConflict('Reconciliation');
    await recordAudit(s, { action: 'reconciliation.completed', entityType: 'reconciliation', entityId: id, details: { closing: detail.statementClosingBalance, cleared: detail.lines.filter((l) => l.cleared).length } });
    return getReconciliation(s, id);
  });
}

export async function reopenReconciliation(s: ServiceContext, id: string, version: number, reason: string): Promise<ReconciliationDetailDto> {
  const session = await loadSession(s, id);
  if (session.version !== version) throw versionConflict('Reconciliation');
  if (session.status === 'in_progress') throw new ServiceError('invalid_state', 'Reconciliation is already in progress');
  const [open] = await s.tx
    .select({ id: schema.reconciliationSessions.id })
    .from(schema.reconciliationSessions)
    .where(and(eq(schema.reconciliationSessions.companyId, s.ctx.companyId), eq(schema.reconciliationSessions.bankAccountId, session.bankAccountId), eq(schema.reconciliationSessions.status, 'in_progress')));
  if (open) throw new ServiceError('invalid_state', 'Another reconciliation is in progress for this account. Finish or delete it first.');
  await s.tx
    .update(schema.reconciliationSessions)
    .set({ status: 'in_progress', completedAt: null, completedBy: null, flaggedReason: null, flaggedAt: null })
    .where(eq(schema.reconciliationSessions.id, id));
  await recordAudit(s, { action: 'reconciliation.reopened', entityType: 'reconciliation', entityId: id, reason });
  return getReconciliation(s, id);
}

export async function deleteReconciliation(s: ServiceContext, id: string): Promise<void> {
  const session = await loadSession(s, id);
  if (session.status !== 'in_progress') throw new ServiceError('invalid_state', 'A completed reconciliation can’t be deleted. Reopen it first.');
  await s.tx.delete(schema.reconciliationSessions).where(eq(schema.reconciliationSessions.id, id));
  await recordAudit(s, { action: 'reconciliation.deleted', entityType: 'reconciliation', entityId: id });
}

export { gte };
