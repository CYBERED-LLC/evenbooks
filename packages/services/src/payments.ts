import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, type EntryLineInput } from '@evenbooks/domain';
import {
  PAYMENT_SORTS,
  type AllocatePaymentInput,
  type CreatePaymentInput,
  type CustomerBalanceDto,
  type ListPaymentsQuery,
  type Page,
  type PaymentDto,
  type ReverseAllocationInput,
  type VoidPaymentInput,
} from '@evenbooks/contracts';
import { keyset, type SortColumns } from './keyset';
import { ServiceError, notFound, plainMoney, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { postEntry } from './ledger';
import { getAccount, getAccountByRole } from './accounts';
import { applyToInvoice, loadInvoiceForUpdate, unapplyFromInvoice } from './settlement';
import { recognizeAdvance } from './recognition';
import { toAllocationDto } from './documents';
import { openInvoicesForContact } from './invoices';

type PaymentRow = typeof schema.payments.$inferSelect;

async function loadPayment(s: ServiceContext, id: string, forUpdate = false): Promise<PaymentRow> {
  const q = s.tx
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.companyId, s.ctx.companyId), eq(schema.payments.id, id)))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Payment');
  return row;
}

async function toDtos(s: ServiceContext, rows: PaymentRow[]): Promise<PaymentDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const allocations = await s.tx
    .select({ a: schema.paymentAllocations, invoiceNumber: schema.invoices.number })
    .from(schema.paymentAllocations)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.paymentAllocations.invoiceId))
    .where(inArray(schema.paymentAllocations.paymentId, ids))
    .orderBy(asc(schema.paymentAllocations.createdAt));
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => Boolean(x)))];
  const contacts = contactIds.length ? await s.tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts).where(inArray(schema.contacts.id, contactIds)) : [];
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const accts = await s.tx.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(inArray(schema.accounts.id, [...new Set(rows.map((r) => r.depositAccountId))]));
  const acctName = new Map(accts.map((a) => [a.id, a.name]));
  const charges = await s.tx.select({ id: schema.processorCharges.id, paymentId: schema.processorCharges.paymentId }).from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), inArray(schema.processorCharges.paymentId, ids)));
  const chargeByPayment = new Map(charges.map((c) => [c.paymentId, c.id]));
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contactId,
    contactName: r.contactId ? contactName.get(r.contactId) ?? null : null,
    date: r.date,
    currency: r.currency,
    amount: Money.round(r.amount, r.currency).toString(),
    method: r.method,
    reference: r.reference,
    memo: r.memo,
    depositAccountId: r.depositAccountId,
    depositAccountName: acctName.get(r.depositAccountId),
    isRefundableDeposit: r.isRefundableDeposit,
    status: r.status,
    amountAllocated: Money.round(r.amountAllocated, r.currency).toString(),
    amountRefunded: Money.round(r.amountRefunded, r.currency).toString(),
    unappliedAmount: Money.round(r.unappliedAmount, r.currency).toString(),
    journalEntryId: r.journalEntryId,
    voidJournalEntryId: r.voidJournalEntryId,
    voidReason: r.voidReason,
    bankTransactionId: r.bankTransactionId,
    processorChargeId: chargeByPayment.get(r.id) ?? null,
    allocations: allocations.filter((x) => x.a.paymentId === r.id).map((x) => toAllocationDto(x.a, r.currency, { invoiceNumber: x.invoiceNumber, sourceLabel: 'Payment' })),
    version: r.version,
    createdAt: r.createdAt,
  }));
}

export async function getPayment(s: ServiceContext, id: string): Promise<PaymentDto> {
  return (await toDtos(s, [await loadPayment(s, id)]))[0]!;
}

type PaymentListRow = { p: PaymentRow; customerSort: string };

// Customer sorts by the contact's current name, case-insensitively; no customer sorts as ''.
const customerSortExpr = sql<string>`lower(coalesce(${schema.contacts.name}, ''))`;

const PAYMENT_SORT_COLUMNS: SortColumns<PaymentListRow, (typeof PAYMENT_SORTS)[number]> = {
  date: { expr: schema.payments.date, cast: 'date', value: (r) => r.p.date },
  amount: { expr: schema.payments.amount, cast: 'numeric', value: (r) => r.p.amount },
  customer: { expr: customerSortExpr, cast: 'text', value: (r) => r.customerSort },
  unapplied: { expr: schema.payments.unappliedAmount, cast: 'numeric', value: (r) => r.p.unappliedAmount },
};

export async function listPayments(s: ServiceContext, q: ListPaymentsQuery): Promise<Page<PaymentDto>> {
  const conds = [eq(schema.payments.companyId, s.ctx.companyId)];
  if (q.contactId) conds.push(eq(schema.payments.contactId, q.contactId));
  if (q.from) conds.push(gte(schema.payments.date, q.from));
  if (q.to) conds.push(lte(schema.payments.date, q.to));
  if (q.status) conds.push(eq(schema.payments.status, q.status));
  if (q.unappliedOnly) conds.push(and(eq(schema.payments.status, 'posted'), gt(schema.payments.unappliedAmount, '0'))!);
  if (q.q) conds.push(or(ilike(schema.payments.reference, `%${q.q}%`), ilike(schema.payments.memo, `%${q.q}%`))!);
  const ks = keyset({
    columns: PAYMENT_SORT_COLUMNS,
    sort: q.sort ?? 'date',
    dir: q.dir ?? 'desc',
    idColumn: schema.payments.id,
    idOf: (r) => r.p.id,
    cursor: q.cursor,
  });
  const [{ total }] = (await s.tx.select({ total: sql<number>`count(*)::int` }).from(schema.payments).where(and(...conds))) as [{ total: number }];
  const rows: PaymentListRow[] = await s.tx
    .select({ p: schema.payments, customerSort: customerSortExpr })
    .from(schema.payments)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.payments.contactId))
    .where(and(...conds, ks.after))
    .orderBy(...ks.orderBy)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit).map((r) => r.p);
  return { items: await toDtos(s, page), nextCursor: ks.next(rows, q.limit), total };
}

async function validateDepositAccount(s: ServiceContext, id: string) {
  const a = await getAccount(s, id);
  if (!(a.role === 'bank' || a.role === 'undeposited_funds' || a.role === 'processor_clearing')) throw new ServiceError('validation', 'Pick the bank account the money went into.');
  return a;
}

/**
 * Record a customer payment. Posting:
 *   Dr deposit account (amount)
 *   Cr Accounts receivable (allocated part)
 *   Cr Customer deposits and credits (unapplied part)
 * Cash basis: allocated parts recognize invoice components; the unapplied part
 * is advance income unless flagged as a refundable deposit.
 */
export async function createPayment(s: ServiceContext, input: CreatePaymentInput): Promise<PaymentDto> {
  return idempotent(s, input.idempotencyKey, input, async () => {
    const cur = s.company.baseCurrency;
    const amount = Money.of(input.amount, cur);
    const deposit = await validateDepositAccount(s, input.depositAccountId);
    if (input.bankTransactionId) {
      const [txn] = await s.tx.select({ t: schema.bankTransactions, ledgerAccountId: schema.bankAccounts.ledgerAccountId })
        .from(schema.bankTransactions).innerJoin(schema.bankAccounts, eq(schema.bankAccounts.id, schema.bankTransactions.bankAccountId))
        .where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), eq(schema.bankTransactions.id, input.bankTransactionId)))
        .for('update', { of: schema.bankTransactions });
      if (!txn) throw notFound('Bank transaction');
      if (txn.t.status !== 'unreviewed' || txn.t.journalEntryId) throw new ServiceError('invalid_state', 'This bank transaction has already been reviewed');
      if (txn.ledgerAccountId !== deposit.id || txn.t.currency !== cur || !Money.round(txn.t.amount, cur).equals(amount)) {
        throw new ServiceError('validation', 'The bank transaction must be an inflow for the same amount, currency and deposit account');
      }
    }
    const ar = await getAccountByRole(s, 'accounts_receivable');
    const deposits = await getAccountByRole(s, 'customer_deposits');
    const allocAmounts = input.allocations.map((a) => Money.of(a.amount, cur));
    const allocated = Money.sum(allocAmounts, cur);
    if (allocated.gt(amount)) throw new ServiceError('over_allocation', 'You applied more to invoices than the payment amount. Lower the amounts, or keep the rest as credit.');
    const unapplied = amount.subtract(allocated);
    if (input.isRefundableDeposit && !allocated.isZero()) {
      throw new ServiceError('validation', 'A deposit you’ll give back can’t go toward invoices when you record it. Apply it later from the payment’s page.');
    }
    // Lock invoices in a stable order to avoid deadlocks between concurrent payments.
    const invoiceIds = [...new Set(input.allocations.map((a) => a.invoiceId))].sort();
    if (invoiceIds.length !== input.allocations.length) throw new ServiceError('validation', 'Each invoice can appear only once.');
    const invoices = new Map<string, Awaited<ReturnType<typeof loadInvoiceForUpdate>>>();
    for (const id of invoiceIds) invoices.set(id, await loadInvoiceForUpdate(s, id));
    let contactId = input.contactId ?? null;
    for (const inv of invoices.values()) {
      if (contactId && inv.contactId !== contactId) throw new ServiceError('validation', `Invoice ${inv.number} belongs to a different customer`);
      contactId ??= inv.contactId;
    }
    const paymentId = randomUUID();
    const lines: EntryLineInput[] = [{ accountId: deposit.id, debit: amount, contactId, memo: input.memo ?? `Payment${input.reference ? ` ${input.reference}` : ''}` }];
    if (!allocated.isZero()) lines.push({ accountId: ar.id, credit: allocated, contactId });
    if (!unapplied.isZero()) lines.push({ accountId: deposits.id, credit: unapplied, contactId, memo: input.isRefundableDeposit ? 'Refundable deposit' : 'Unapplied' });
    const entry = await postEntry(s, {
      date: input.date,
      memo: `Payment${input.reference ? ` ${input.reference}` : ''}${contactId ? '' : ''}`,
      sourceType: 'payment',
      sourceId: paymentId,
      cashTreatment: 'derived',
      lines,
    });
    const [payment] = await s.tx
      .insert(schema.payments)
      .values({
        id: paymentId,
        companyId: s.ctx.companyId,
        contactId,
        date: input.date,
        currency: cur,
        amount: amount.toString(),
        method: input.method,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        depositAccountId: deposit.id,
        isRefundableDeposit: input.isRefundableDeposit,
        amountAllocated: allocated.toString(),
        amountRefunded: '0',
        unappliedAmount: unapplied.toString(),
        journalEntryId: entry.id,
        bankTransactionId: input.bankTransactionId ?? null,
        createdBy: s.ctx.actorId,
      })
      .returning();
    for (const [i, a] of input.allocations.entries()) {
      await applyToInvoice(s, {
        invoice: invoices.get(a.invoiceId)!,
        amount: allocAmounts[i]!,
        date: input.date,
        sourceType: 'payment',
        paymentId,
        journalEntryId: null,
        contactId,
      });
      // refresh the locked row for a second allocation to the same invoice (not allowed above, but keep the map coherent)
      invoices.set(a.invoiceId, await loadInvoiceForUpdate(s, a.invoiceId));
    }
    if (!unapplied.isZero() && !input.isRefundableDeposit) {
      await recognizeAdvance(s, { amount: unapplied, date: input.date, eventType: 'payment_unapplied', eventId: paymentId, paymentId, contactId, journalEntryId: entry.id });
    }
    if (input.bankTransactionId) {
      await s.tx.insert(schema.transactionMatches).values({ companyId: s.ctx.companyId, bankTransactionId: input.bankTransactionId, targetType: 'payment', targetId: paymentId, amount: amount.toString(), createdBy: s.ctx.actorId });
      const matched = await s.tx
        .update(schema.bankTransactions)
        .set({ status: 'matched', journalEntryId: entry.id, reviewedAt: new Date().toISOString(), reviewedBy: s.ctx.actorId })
        .where(and(eq(schema.bankTransactions.id, input.bankTransactionId), eq(schema.bankTransactions.status, 'unreviewed'))).returning({ id: schema.bankTransactions.id });
      if (!matched.length) throw new ServiceError('invalid_state', 'This bank transaction has already been reviewed');
    }
    await recordAudit(s, { action: 'payment.created', entityType: 'payment', entityId: paymentId, details: { amount: amount.toString(), allocated: allocated.toString(), unapplied: unapplied.toString(), entryNumber: entry.entryNumber } });
    return getPayment(s, payment!.id);
  });
}

/** Apply unapplied funds to invoices later: Dr Customer deposits / Cr AR. */
export async function allocatePayment(s: ServiceContext, id: string, input: AllocatePaymentInput): Promise<PaymentDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const p = await loadPayment(s, id, true);
    if (p.status !== 'posted') throw new ServiceError('invalid_state', 'This payment is void.');
    if (p.version !== input.version) throw versionConflict('Payment');
    const cur = p.currency;
    const amounts = input.allocations.map((a) => Money.of(a.amount, cur));
    const total = Money.sum(amounts, cur);
    const unapplied = Money.round(p.unappliedAmount, cur);
    if (total.gt(unapplied)) throw new ServiceError('over_allocation', `Only ${plainMoney(unapplied, cur)} of this payment is still free to apply.`);
    const date = input.date ?? p.date;
    if (date < p.date) throw new ServiceError('validation', 'The date applied can’t be before the payment date.');
    const ar = await getAccountByRole(s, 'accounts_receivable');
    const deposits = await getAccountByRole(s, 'customer_deposits');
    const ids = [...new Set(input.allocations.map((a) => a.invoiceId))].sort();
    if (ids.length !== input.allocations.length) throw new ServiceError('validation', 'Each invoice can appear only once.');
    const invoices = new Map<string, Awaited<ReturnType<typeof loadInvoiceForUpdate>>>();
    for (const invId of ids) invoices.set(invId, await loadInvoiceForUpdate(s, invId));
    const entry = await postEntry(s, {
      date,
      memo: `Apply payment${p.reference ? ` ${p.reference}` : ''} to invoices`,
      sourceType: 'allocation',
      sourceId: p.id,
      cashTreatment: 'derived',
      lines: [
        { accountId: deposits.id, debit: total, contactId: p.contactId },
        { accountId: ar.id, credit: total, contactId: p.contactId },
      ],
    });
    for (const [i, a] of input.allocations.entries()) {
      await applyToInvoice(s, { invoice: invoices.get(a.invoiceId)!, amount: amounts[i]!, date, sourceType: 'payment', paymentId: p.id, journalEntryId: entry.id, contactId: p.contactId });
    }
    if (!p.isRefundableDeposit) {
      // reclassify: the advance income becomes invoice income
      await recognizeAdvance(s, { amount: total.negate(), date, eventType: 'advance_applied', eventId: entry.id, paymentId: p.id, contactId: p.contactId, journalEntryId: entry.id });
    }
    await s.tx
      .update(schema.payments)
      .set({ amountAllocated: Money.round(p.amountAllocated, cur).add(total).toString(), unappliedAmount: unapplied.subtract(total).toString() })
      .where(eq(schema.payments.id, p.id));
    await recordAudit(s, { action: 'payment.allocated', entityType: 'payment', entityId: p.id, details: { amount: total.toString(), entryNumber: entry.entryNumber } });
    return getPayment(s, p.id);
  });
}

/** Reverse one allocation: Dr AR / Cr Customer deposits; funds become unapplied again. */
export async function reverseAllocation(s: ServiceContext, allocationId: string, input: ReverseAllocationInput): Promise<PaymentDto> {
  return idempotent(s, input.idempotencyKey, { allocationId, ...input }, async () => {
    const [alloc] = await s.tx
      .select()
      .from(schema.paymentAllocations)
      .where(and(eq(schema.paymentAllocations.companyId, s.ctx.companyId), eq(schema.paymentAllocations.id, allocationId)))
      .for('update');
    if (!alloc) throw notFound('Allocation');
    if (alloc.sourceType !== 'payment' || !alloc.paymentId) throw new ServiceError('validation', 'This was applied from a credit note. Remove it from the credit note’s page.');
    if (alloc.status === 'reversed') throw new ServiceError('invalid_state', 'This was already removed from the invoice.');
    const p = await loadPayment(s, alloc.paymentId, true);
    const cur = p.currency;
    const amount = Money.round(alloc.amount, cur);
    const date = input.date ?? alloc.date;
    if (date < alloc.date) throw new ServiceError('validation', 'The date can’t be before the date it was applied.');
    const ar = await getAccountByRole(s, 'accounts_receivable');
    const deposits = await getAccountByRole(s, 'customer_deposits');
    const entry = await postEntry(s, {
      date,
      memo: `Reverse allocation: ${input.reason}`,
      sourceType: 'allocation_reversal',
      sourceId: p.id,
      cashTreatment: 'derived',
      lines: [
        { accountId: ar.id, debit: amount, contactId: p.contactId },
        { accountId: deposits.id, credit: amount, contactId: p.contactId },
      ],
    });
    await unapplyFromInvoice(s, alloc, date, entry.id);
    if (!p.isRefundableDeposit) {
      await recognizeAdvance(s, { amount, date, eventType: 'allocation_reversal_advance', eventId: entry.id, paymentId: p.id, contactId: p.contactId, journalEntryId: entry.id });
    }
    await s.tx
      .update(schema.payments)
      .set({ amountAllocated: Money.round(p.amountAllocated, cur).subtract(amount).toString(), unappliedAmount: Money.round(p.unappliedAmount, cur).add(amount).toString() })
      .where(eq(schema.payments.id, p.id));
    await recordAudit(s, { action: 'payment.allocation_reversed', entityType: 'payment', entityId: p.id, reason: input.reason, details: { allocationId, amount: amount.toString() } });
    return getPayment(s, p.id);
  });
}

/** Void a payment that has no active allocations and no refunds. */
export async function voidPayment(s: ServiceContext, id: string, input: VoidPaymentInput): Promise<PaymentDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const p = await loadPayment(s, id, true);
    if (p.status === 'void') throw new ServiceError('invalid_state', 'This payment is already void.');
    if (p.version !== input.version) throw versionConflict('Payment');
    const cur = p.currency;
    if (!Money.round(p.amountAllocated, cur).isZero()) throw new ServiceError('invalid_state', 'Remove this payment from its invoices before voiding it.');
    if (!Money.round(p.amountRefunded, cur).isZero()) throw new ServiceError('invalid_state', 'This payment has refunds. Void those first.');
    const [online] = await s.tx.select({ id: schema.processorCharges.id }).from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), eq(schema.processorCharges.paymentId, p.id))).limit(1);
    if (online) throw new ServiceError('invalid_state', 'This payment was made online. Refund it from the invoice page instead of voiding it.');
    const date = input.date ?? p.date;
    if (date < p.date) throw new ServiceError('validation', 'The void date can’t be before the payment date.');
    // Nothing is applied or refunded now, so the whole payment sits in customer deposits, whatever the
    // original entry credited: undoing those lines would re-debit receivables for allocations that were
    // already reversed (each reversal moved its amount from receivables back to customer deposits).
    const deposits = await getAccountByRole(s, 'customer_deposits');
    const amount = Money.round(p.amount, cur);
    const reversal = await postEntry(s, {
      date,
      memo: `Void payment: ${input.reason}`,
      sourceType: 'payment_void',
      sourceId: p.id,
      cashTreatment: 'derived',
      lines: [
        { accountId: deposits.id, debit: amount, contactId: p.contactId, memo: p.isRefundableDeposit ? 'Refundable deposit' : 'Unapplied' },
        { accountId: p.depositAccountId, credit: amount, contactId: p.contactId },
      ],
      reversesEntryId: p.journalEntryId,
    });
    await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, p.journalEntryId));
    const unapplied = Money.round(p.unappliedAmount, cur);
    if (!unapplied.isZero() && !p.isRefundableDeposit) {
      await recognizeAdvance(s, { amount: unapplied.negate(), date, eventType: 'payment_void', eventId: reversal.id, paymentId: p.id, contactId: p.contactId, journalEntryId: reversal.id });
    }
    await s.tx
      .update(schema.payments)
      .set({ status: 'void', voidJournalEntryId: reversal.id, voidedAt: new Date().toISOString(), voidReason: input.reason })
      .where(eq(schema.payments.id, p.id));
    if (p.bankTransactionId) {
      await s.tx.delete(schema.transactionMatches).where(and(eq(schema.transactionMatches.targetType, 'payment'), eq(schema.transactionMatches.targetId, p.id)));
      await s.tx.update(schema.bankTransactions).set({ status: 'unreviewed', journalEntryId: null, reviewedAt: null, reviewedBy: null }).where(and(eq(schema.bankTransactions.id, p.bankTransactionId), eq(schema.bankTransactions.status, 'matched'), eq(schema.bankTransactions.journalEntryId, p.journalEntryId)));
    }
    await recordAudit(s, { action: 'payment.voided', entityType: 'payment', entityId: p.id, reason: input.reason, details: { reversalEntryId: reversal.id } });
    return getPayment(s, p.id);
  });
}

export async function customerBalance(s: ServiceContext, contactId: string): Promise<CustomerBalanceDto> {
  const cur = s.company.baseCurrency;
  const openInvoices = await openInvoicesForContact(s, contactId);
  const payments = await s.tx
    .select()
    .from(schema.payments)
    .where(and(eq(schema.payments.companyId, s.ctx.companyId), eq(schema.payments.contactId, contactId), eq(schema.payments.status, 'posted'), gt(schema.payments.unappliedAmount, '0')))
    .orderBy(asc(schema.payments.date));
  const credits = await s.tx
    .select()
    .from(schema.creditNotes)
    .where(and(eq(schema.creditNotes.companyId, s.ctx.companyId), eq(schema.creditNotes.contactId, contactId), eq(schema.creditNotes.status, 'issued'), gt(schema.creditNotes.balance, '0')))
    .orderBy(asc(schema.creditNotes.issueDate));
  return {
    contactId,
    openInvoices,
    unappliedPayments: payments.map((p) => ({ id: p.id, date: p.date, unappliedAmount: Money.round(p.unappliedAmount, cur).toString(), reference: p.reference, isRefundableDeposit: p.isRefundableDeposit })),
    openCreditNotes: credits.map((c) => ({ id: c.id, number: c.number!, issueDate: c.issueDate, balance: Money.round(c.balance, cur).toString() })),
    totalReceivable: Money.sum(openInvoices.map((i) => Money.of(i.balanceDue, cur)), cur).toString(),
    totalCredits: Money.sum([...payments.map((p) => Money.round(p.unappliedAmount, cur)), ...credits.map((c) => Money.round(c.balance, cur))], cur).toString(),
  };
}
