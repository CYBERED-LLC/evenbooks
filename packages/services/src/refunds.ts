import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, reverseLines } from '@evenbooks/domain';
import type { CreateRefundInput, RefundDto } from '@evenbooks/contracts';
import { ServiceError, notFound, plainMoney } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { postEntry } from './ledger';
import { getAccount, getAccountByRole } from './accounts';
import { recognizeAdvance, recognizeSettlement } from './recognition';
import { consumeCreditNote, loadCreditNote } from './credit-notes';

type RefundRow = typeof schema.refunds.$inferSelect;

async function toDtos(s: ServiceContext, rows: RefundRow[]): Promise<RefundDto[]> {
  if (rows.length === 0) return [];
  const accts = await s.tx.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(inArray(schema.accounts.id, [...new Set(rows.map((r) => r.fromAccountId))]));
  const name = new Map(accts.map((a) => [a.id, a.name]));
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    sourceType: r.sourceType,
    paymentId: r.paymentId,
    creditNoteId: r.creditNoteId,
    date: r.date,
    amount: Money.round(r.amount, s.company.baseCurrency).toString(),
    fromAccountId: r.fromAccountId,
    fromAccountName: name.get(r.fromAccountId),
    method: r.method,
    reference: r.reference,
    memo: r.memo,
    status: r.status,
    journalEntryId: r.journalEntryId,
    voidJournalEntryId: r.voidJournalEntryId,
    createdAt: r.createdAt,
  }));
}

/**
 * Cash refund of unapplied customer funds or a credit note balance:
 *   Dr Customer deposits and credits / Cr bank
 * Cash basis: −advance income (payment source) or −credit-note components.
 */
export async function createRefund(s: ServiceContext, input: CreateRefundInput): Promise<RefundDto> {
  return idempotent(s, input.idempotencyKey, input, async () => {
    const cur = s.company.baseCurrency;
    const amount = Money.of(input.amount, cur);
    const from = await getAccount(s, input.fromAccountId);
    if (!(from.role === 'bank' || from.role === 'undeposited_funds' || from.role === 'credit_card' || from.role === 'processor_clearing')) throw new ServiceError('validation', 'Refunds are paid from a bank, card or payment processor account');
    const deposits = await getAccountByRole(s, 'customer_deposits');
    const refundId = randomUUID();
    let contactId: string | null = null;
    if (input.sourceType === 'payment') {
      const [p] = await s.tx
        .select()
        .from(schema.payments)
        .where(and(eq(schema.payments.companyId, s.ctx.companyId), eq(schema.payments.id, input.sourceId)))
        .for('update');
      if (!p) throw notFound('Payment');
      if (p.status !== 'posted') throw new ServiceError('invalid_state', 'This payment is void.');
      const unapplied = Money.round(p.unappliedAmount, cur);
      if (amount.gt(unapplied)) throw new ServiceError('over_allocation', `Only ${plainMoney(unapplied, cur)} of this payment is still free to refund.`);
      if (input.date < p.date) throw new ServiceError('validation', 'The refund date can’t be before the payment date.');
      contactId = p.contactId;
      const entry = await postEntry(s, {
        date: input.date,
        memo: input.memo ?? `Refund${input.reference ? ` ${input.reference}` : ''}`,
        sourceType: 'refund',
        sourceId: refundId,
        cashTreatment: 'derived',
        lines: [
          { accountId: deposits.id, debit: amount, contactId },
          { accountId: from.id, credit: amount, contactId },
        ],
      });
      await s.tx.insert(schema.refunds).values({
        id: refundId,
        companyId: s.ctx.companyId,
        contactId,
        sourceType: 'payment',
        paymentId: p.id,
        date: input.date,
        amount: amount.toString(),
        fromAccountId: from.id,
        method: input.method,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        journalEntryId: entry.id,
        createdBy: s.ctx.actorId,
      });
      await s.tx
        .update(schema.payments)
        .set({ amountRefunded: Money.round(p.amountRefunded, cur).add(amount).toString(), unappliedAmount: unapplied.subtract(amount).toString() })
        .where(eq(schema.payments.id, p.id));
      if (!p.isRefundableDeposit) {
        await recognizeAdvance(s, { amount: amount.negate(), date: input.date, eventType: 'refund', eventId: refundId, paymentId: p.id, contactId, journalEntryId: entry.id });
      }
    } else {
      const cn = await loadCreditNote(s, input.sourceId, true);
      if (cn.status !== 'issued') throw new ServiceError('invalid_state', cn.status === 'draft' ? 'Issue this credit note first.' : 'This credit note is void.');
      if (input.date < cn.issueDate) throw new ServiceError('validation', 'The refund date can’t be before the credit note date.');
      contactId = cn.contactId;
      const entry = await postEntry(s, {
        date: input.date,
        memo: input.memo ?? `Refund credit note ${cn.number}`,
        sourceType: 'refund',
        sourceId: refundId,
        cashTreatment: 'derived',
        lines: [
          { accountId: deposits.id, debit: amount, contactId },
          { accountId: from.id, credit: amount, contactId },
        ],
      });
      await s.tx.insert(schema.refunds).values({
        id: refundId,
        companyId: s.ctx.companyId,
        contactId,
        sourceType: 'credit_note',
        creditNoteId: cn.id,
        date: input.date,
        amount: amount.toString(),
        fromAccountId: from.id,
        method: input.method,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        journalEntryId: entry.id,
        createdBy: s.ctx.actorId,
      });
      await consumeCreditNote(s, cn, amount, input.date, 'refund', refundId, entry.id);
    }
    await recordAudit(s, { action: 'refund.created', entityType: 'refund', entityId: refundId, details: { amount: amount.toString(), sourceType: input.sourceType, sourceId: input.sourceId } });
    return getRefund(s, refundId);
  });
}

export async function voidRefund(s: ServiceContext, id: string, input: { reason: string; idempotencyKey?: string }): Promise<RefundDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const [r] = await s.tx
      .select()
      .from(schema.refunds)
      .where(and(eq(schema.refunds.companyId, s.ctx.companyId), eq(schema.refunds.id, id)))
      .for('update');
    if (!r) throw notFound('Refund');
    if (r.status === 'void') throw new ServiceError('invalid_state', 'This refund is already void.');
    const [online] = await s.tx.select({ id: schema.processorRefunds.id }).from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.refundId, r.id))).limit(1);
    if (online) throw new ServiceError('invalid_state', 'This refund was made through Stripe and the money has already left, so it can’t be voided here.');
    const cur = s.company.baseCurrency;
    const amount = Money.round(r.amount, cur);
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, r.journalEntryId)).orderBy(asc(schema.journalLines.lineNo));
    const reversal = await postEntry(s, {
      date: r.date,
      memo: `Void refund: ${input.reason}`,
      sourceType: 'refund_void',
      sourceId: r.id,
      cashTreatment: 'derived',
      lines: reverseLines(lines.map((l) => ({ accountId: l.accountId, debit: Money.round(l.debit, cur), credit: Money.round(l.credit, cur), memo: l.memo, contactId: l.contactId }))),
      reversesEntryId: r.journalEntryId,
    });
    await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, r.journalEntryId));
    if (r.sourceType === 'payment' && r.paymentId) {
      const [p] = await s.tx.select().from(schema.payments).where(eq(schema.payments.id, r.paymentId)).for('update');
      if (p) {
        if (p.status !== 'posted') throw new ServiceError('invalid_state', 'The refunded payment is void.');
        await s.tx
          .update(schema.payments)
          .set({ amountRefunded: Money.round(p.amountRefunded, cur).subtract(amount).toString(), unappliedAmount: Money.round(p.unappliedAmount, cur).add(amount).toString() })
          .where(eq(schema.payments.id, p.id));
        if (!p.isRefundableDeposit) {
          await recognizeAdvance(s, { amount, date: r.date, eventType: 'refund_void', eventId: reversal.id, paymentId: p.id, contactId: p.contactId, journalEntryId: reversal.id });
        }
      }
    } else if (r.creditNoteId) {
      const cn = await loadCreditNote(s, r.creditNoteId, true);
      const usedBefore = Money.round(cn.amountUsed, cur);
      await recognizeSettlement(s, { documentType: 'credit_note', documentId: cn.id, cumulativeBefore: usedBefore, applied: amount.negate(), date: r.date, eventType: 'refund_void', eventId: reversal.id, contactId: cn.contactId, journalEntryId: reversal.id });
      const usedAfter = usedBefore.subtract(amount);
      await s.tx
        .update(schema.creditNotes)
        .set({ amountUsed: usedAfter.toString(), balance: Money.round(cn.total, cur).subtract(usedAfter).toString(), status: 'issued' })
        .where(eq(schema.creditNotes.id, cn.id));
    }
    await s.tx.update(schema.refunds).set({ status: 'void', voidJournalEntryId: reversal.id }).where(eq(schema.refunds.id, id));
    await recordAudit(s, { action: 'refund.voided', entityType: 'refund', entityId: id, reason: input.reason });
    return getRefund(s, id);
  });
}

export async function getRefund(s: ServiceContext, id: string): Promise<RefundDto> {
  const [r] = await s.tx
    .select()
    .from(schema.refunds)
    .where(and(eq(schema.refunds.companyId, s.ctx.companyId), eq(schema.refunds.id, id)));
  if (!r) throw notFound('Refund');
  return (await toDtos(s, [r]))[0]!;
}

export async function listRefunds(s: ServiceContext, filter: { paymentId?: string; creditNoteId?: string; contactId?: string } = {}): Promise<RefundDto[]> {
  const conds = [eq(schema.refunds.companyId, s.ctx.companyId)];
  if (filter.paymentId) conds.push(eq(schema.refunds.paymentId, filter.paymentId));
  if (filter.creditNoteId) conds.push(eq(schema.refunds.creditNoteId, filter.creditNoteId));
  if (filter.contactId) conds.push(eq(schema.refunds.contactId, filter.contactId));
  const rows = await s.tx
    .select()
    .from(schema.refunds)
    .where(and(...conds))
    .orderBy(desc(schema.refunds.date))
    .limit(200);
  return toDtos(s, rows);
}
