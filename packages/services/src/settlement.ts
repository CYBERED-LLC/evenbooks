import { and, eq } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import { ServiceError, notFound, plainMoney } from './errors';
import type { ServiceContext } from './context';
import { recognizeSettlement } from './recognition';

type InvoiceRow = typeof schema.invoices.$inferSelect;
type AllocationRow = typeof schema.paymentAllocations.$inferSelect;

/**
 * Shared settlement primitive: apply funds (from a payment or a credit note) to
 * an issued invoice. Updates the invoice balance/status, records the allocation,
 * and recognizes the settled portion on the cash basis. Over-allocation and
 * settlement of non-issued invoices are rejected.
 */
export async function loadInvoiceForUpdate(s: ServiceContext, invoiceId: string): Promise<InvoiceRow> {
  const [row] = await s.tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, s.ctx.companyId), eq(schema.invoices.id, invoiceId)))
    .for('update');
  if (!row) throw notFound('Invoice');
  return row;
}

export interface ApplyInput {
  invoice: InvoiceRow;
  amount: Money;
  date: string;
  sourceType: 'payment' | 'credit_note';
  paymentId?: string | null;
  creditNoteId?: string | null;
  /** Entry that carried the AR credit (null when part of the payment's own entry). */
  journalEntryId: string | null;
  contactId: string | null;
  /** Recognize on the cash basis (false for refundable deposits being applied? No: applying always recognizes; see payments.ts). */
  recognize?: boolean;
}

export async function applyToInvoice(s: ServiceContext, input: ApplyInput): Promise<{ allocation: AllocationRow; invoice: InvoiceRow }> {
  const cur = s.company.baseCurrency;
  const inv = input.invoice;
  if (inv.status !== 'issued') throw new ServiceError('invalid_state', inv.status === 'draft' ? 'Finish and issue this invoice before recording a payment for it.' : `${inv.number ? `Invoice ${inv.number}` : 'This invoice'} is ${inv.status === 'void' ? 'void' : 'already paid'} and can’t take a payment.`);
  if (!input.amount.isPositive()) throw new ServiceError('validation', 'Enter an amount greater than zero.');
  const balance = Money.round(inv.balanceDue, cur);
  if (input.amount.gt(balance)) {
    throw new ServiceError('over_allocation', `That’s more than the ${plainMoney(balance, cur)} still due on invoice ${inv.number}.`);
  }
  if (input.contactId && inv.contactId !== input.contactId) {
    throw new ServiceError('validation', `Invoice ${inv.number} belongs to a different customer`);
  }
  const settledBefore = Money.round(inv.amountSettled, cur);
  const settledAfter = settledBefore.add(input.amount);
  const newBalance = Money.round(inv.total, cur).subtract(settledAfter);
  const [allocation] = await s.tx
    .insert(schema.paymentAllocations)
    .values({
      companyId: s.ctx.companyId,
      sourceType: input.sourceType,
      paymentId: input.paymentId ?? null,
      creditNoteId: input.creditNoteId ?? null,
      invoiceId: inv.id,
      amount: input.amount.toString(),
      date: input.date,
      journalEntryId: input.journalEntryId,
      createdBy: s.ctx.actorId,
    })
    .returning();
  const [updated] = await s.tx
    .update(schema.invoices)
    .set({ amountSettled: settledAfter.toString(), balanceDue: newBalance.toString(), status: newBalance.isZero() ? 'paid' : 'issued' })
    .where(eq(schema.invoices.id, inv.id))
    .returning();
  if (input.recognize !== false) {
    await recognizeSettlement(s, {
      documentType: 'invoice',
      documentId: inv.id,
      cumulativeBefore: settledBefore,
      applied: input.amount,
      date: input.date,
      eventType: input.sourceType === 'payment' ? 'payment_allocation' : 'credit_allocation',
      eventId: allocation!.id,
      contactId: inv.contactId,
      journalEntryId: input.journalEntryId,
    });
  }
  return { allocation: allocation!, invoice: updated! };
}

/** Undo an allocation's effect on the invoice and de-recognize the settled portion. */
export async function unapplyFromInvoice(s: ServiceContext, allocation: AllocationRow, date: string, reversalEntryId: string, recognize = true): Promise<InvoiceRow> {
  const cur = s.company.baseCurrency;
  const inv = await loadInvoiceForUpdate(s, allocation.invoiceId);
  if (inv.status === 'void') throw new ServiceError('invalid_state', 'This invoice is void.');
  const amount = Money.round(allocation.amount, cur);
  const settledBefore = Money.round(inv.amountSettled, cur);
  const settledAfter = settledBefore.subtract(amount);
  if (settledAfter.isNegative()) throw new ServiceError('internal', 'Settlement bookkeeping is inconsistent');
  const newBalance = Money.round(inv.total, cur).subtract(settledAfter);
  const [updated] = await s.tx
    .update(schema.invoices)
    .set({ amountSettled: settledAfter.toString(), balanceDue: newBalance.toString(), status: newBalance.isZero() ? 'paid' : 'issued' })
    .where(eq(schema.invoices.id, inv.id))
    .returning();
  await s.tx
    .update(schema.paymentAllocations)
    .set({ status: 'reversed', reversalJournalEntryId: reversalEntryId, reversedAt: new Date().toISOString() })
    .where(eq(schema.paymentAllocations.id, allocation.id));
  if (recognize) {
    await recognizeSettlement(s, {
      documentType: 'invoice',
      documentId: inv.id,
      cumulativeBefore: settledBefore,
      applied: amount.negate(),
      date,
      eventType: 'allocation_reversal',
      eventId: allocation.id,
      contactId: inv.contactId,
      journalEntryId: reversalEntryId,
    });
  }
  return updated!;
}
