import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, reverseLines, type EntryLineInput } from '@evenbooks/domain';
import {
  CREDIT_NOTE_SORTS,
  type ApplyCreditNoteInput,
  type CreateCreditNoteInput,
  type CreditNoteDto,
  type IssueCreditNoteInput,
  type ListCreditNotesQuery,
  type Page,
  type VoidInvoiceInput,
} from '@evenbooks/contracts';
import { keyset, type SortColumns } from './keyset';
import { ServiceError, notFound, plainMoney, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { postEntry } from './ledger';
import { getAccountByRole } from './accounts';
import { accountNames, computeDocument, lineRows, snapshotCustomer, toAllocationDto, toLineDto, totalsRow } from './documents';
import { applyToInvoice, loadInvoiceForUpdate } from './settlement';
import { recognizeSettlement } from './recognition';

type CreditNoteRow = typeof schema.creditNotes.$inferSelect;

async function toDtos(s: ServiceContext, rows: CreditNoteRow[], full: boolean): Promise<CreditNoteDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const contacts = await s.tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts).where(inArray(schema.contacts.id, [...new Set(rows.map((r) => r.contactId))]));
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const invIds = rows.map((r) => r.invoiceId).filter((x): x is string => Boolean(x));
  const invs = invIds.length ? await s.tx.select({ id: schema.invoices.id, number: schema.invoices.number }).from(schema.invoices).where(inArray(schema.invoices.id, invIds)) : [];
  const invNumber = new Map(invs.map((i) => [i.id, i.number]));
  const lines = full ? await s.tx.select().from(schema.creditNoteLines).where(inArray(schema.creditNoteLines.creditNoteId, ids)).orderBy(asc(schema.creditNoteLines.lineNo)) : [];
  const names = await accountNames(
    s,
    lines.map((l) => l.incomeAccountId),
  );
  const allocations = full
    ? await s.tx
        .select({ a: schema.paymentAllocations, invoiceNumber: schema.invoices.number })
        .from(schema.paymentAllocations)
        .innerJoin(schema.invoices, eq(schema.invoices.id, schema.paymentAllocations.invoiceId))
        .where(inArray(schema.paymentAllocations.creditNoteId, ids))
        .orderBy(asc(schema.paymentAllocations.createdAt))
    : [];
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    contactId: r.contactId,
    contactName: contactName.get(r.contactId),
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceId ? invNumber.get(r.invoiceId) ?? null : null,
    customerSnapshot: r.customerSnapshot,
    issueDate: r.issueDate,
    reason: r.reason,
    documentDiscount: r.documentDiscount ?? null,
    currency: r.currency,
    subtotal: Money.round(r.subtotal, r.currency).toString(),
    discountTotal: Money.round(r.discountTotal, r.currency).toString(),
    netTotal: Money.round(r.netTotal, r.currency).toString(),
    taxTotal: Money.round(r.taxTotal, r.currency).toString(),
    total: Money.round(r.total, r.currency).toString(),
    taxSummary: r.taxSummary,
    amountUsed: Money.round(r.amountUsed, r.currency).toString(),
    balance: Money.round(r.balance, r.currency).toString(),
    journalEntryId: r.journalEntryId,
    voidJournalEntryId: r.voidJournalEntryId,
    voidReason: r.voidReason,
    lines: lines.filter((l) => l.creditNoteId === r.id).map((l) => toLineDto(l, r.currency, names.get(l.incomeAccountId))),
    allocations: full ? allocations.filter((x) => x.a.creditNoteId === r.id).map((x) => toAllocationDto(x.a, r.currency, { invoiceNumber: x.invoiceNumber, sourceLabel: 'Credit note' })) : undefined,
    version: r.version,
    createdAt: r.createdAt,
  }));
}

export async function loadCreditNote(s: ServiceContext, id: string, forUpdate = false): Promise<CreditNoteRow> {
  const q = s.tx
    .select()
    .from(schema.creditNotes)
    .where(and(eq(schema.creditNotes.companyId, s.ctx.companyId), eq(schema.creditNotes.id, id)))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Credit note');
  return row;
}

export async function getCreditNote(s: ServiceContext, id: string): Promise<CreditNoteDto> {
  return (await toDtos(s, [await loadCreditNote(s, id)], true))[0]!;
}

type CreditNoteListRow = { cn: CreditNoteRow; customerSort: string };

// Customer sorts by the contact's current name (what the list shows), case-insensitively.
const customerSortExpr = sql<string>`lower(coalesce(${schema.contacts.name}, ''))`;

const CREDIT_NOTE_SORT_COLUMNS: SortColumns<CreditNoteListRow, (typeof CREDIT_NOTE_SORTS)[number]> = {
  issueDate: { expr: schema.creditNotes.issueDate, cast: 'date', value: (r) => r.cn.issueDate },
  // drafts have no number yet; they sort as ''
  number: { expr: sql`coalesce(${schema.creditNotes.number}, '')`, cast: 'text', value: (r) => r.cn.number ?? '' },
  total: { expr: schema.creditNotes.total, cast: 'numeric', value: (r) => r.cn.total },
  customer: { expr: customerSortExpr, cast: 'text', value: (r) => r.customerSort },
};

export async function listCreditNotes(s: ServiceContext, q: ListCreditNotesQuery): Promise<Page<CreditNoteDto>> {
  const conds = [eq(schema.creditNotes.companyId, s.ctx.companyId)];
  if (q.status) conds.push(eq(schema.creditNotes.status, q.status));
  if (q.contactId) conds.push(eq(schema.creditNotes.contactId, q.contactId));
  if (q.from) conds.push(gte(schema.creditNotes.issueDate, q.from));
  if (q.to) conds.push(lte(schema.creditNotes.issueDate, q.to));
  if (q.q) {
    const like = `%${q.q}%`;
    conds.push(
      or(
        ilike(schema.creditNotes.number, like),
        ilike(schema.creditNotes.reason, like),
        sql`exists (select 1 from ${schema.contacts} c where c.id = ${schema.creditNotes.contactId} and c.name ilike ${like})`,
      )!,
    );
  }
  const ks = keyset({
    columns: CREDIT_NOTE_SORT_COLUMNS,
    sort: q.sort ?? 'issueDate',
    dir: q.dir ?? 'desc',
    idColumn: schema.creditNotes.id,
    idOf: (r) => r.cn.id,
    cursor: q.cursor,
  });
  const [{ total }] = (await s.tx.select({ total: sql<number>`count(*)::int` }).from(schema.creditNotes).where(and(...conds))) as [{ total: number }];
  const rows: CreditNoteListRow[] = await s.tx
    .select({ cn: schema.creditNotes, customerSort: customerSortExpr })
    .from(schema.creditNotes)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.creditNotes.contactId))
    .where(and(...conds, ks.after))
    .orderBy(...ks.orderBy)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit).map((r) => r.cn);
  return { items: await toDtos(s, page, false), nextCursor: ks.next(rows, q.limit), total };
}

export async function createDraftCreditNote(s: ServiceContext, input: CreateCreditNoteInput): Promise<CreditNoteDto> {
  const computed = await computeDocument(s, input.lines, input.documentDiscount);
  const snapshot = await snapshotCustomer(s, input.contactId);
  if (input.invoiceId) {
    const inv = await loadInvoiceForUpdate(s, input.invoiceId);
    if (inv.contactId !== input.contactId) throw new ServiceError('validation', 'Invoice belongs to a different customer');
    if (inv.status === 'draft' || inv.status === 'void') throw new ServiceError('validation', 'Pick an invoice that has been issued.');
  }
  const [row] = await s.tx
    .insert(schema.creditNotes)
    .values({
      companyId: s.ctx.companyId,
      contactId: input.contactId,
      invoiceId: input.invoiceId ?? null,
      status: 'draft',
      currency: s.company.baseCurrency,
      issueDate: input.issueDate,
      reason: input.reason ?? null,
      customerSnapshot: snapshot,
      documentDiscount: input.documentDiscount ?? null,
      ...totalsRow(computed),
      balance: computed.calc.total.toString(),
      createdBy: s.ctx.actorId,
    })
    .returning();
  await s.tx.insert(schema.creditNoteLines).values(lineRows(s, computed).map((l) => ({ ...l, creditNoteId: row!.id })));
  await recordAudit(s, { action: 'credit_note.draft_created', entityType: 'credit_note', entityId: row!.id });
  return getCreditNote(s, row!.id);
}

export async function updateDraftCreditNote(s: ServiceContext, id: string, input: Partial<CreateCreditNoteInput> & { version: number }): Promise<CreditNoteDto> {
  const cn = await loadCreditNote(s, id);
  if (cn.status !== 'draft') throw new ServiceError('immutable', 'This credit note has been issued, so it can’t change. Void it and create a new one.');
  if (cn.version !== input.version) throw versionConflict('Credit note');
  const current = await s.tx.select().from(schema.creditNoteLines).where(eq(schema.creditNoteLines.creditNoteId, id)).orderBy(asc(schema.creditNoteLines.lineNo));
  const lines = input.lines ?? current.map((l) => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount ?? null, incomeAccountId: l.incomeAccountId, taxRateIds: l.taxRateIds }));
  const documentDiscount = input.documentDiscount === undefined ? cn.documentDiscount : input.documentDiscount;
  const computed = await computeDocument(s, lines, documentDiscount);
  const contactId = input.contactId ?? cn.contactId;
  const snapshot = contactId !== cn.contactId ? await snapshotCustomer(s, contactId) : cn.customerSnapshot;
  await s.tx.delete(schema.creditNoteLines).where(eq(schema.creditNoteLines.creditNoteId, id));
  await s.tx.insert(schema.creditNoteLines).values(lineRows(s, computed).map((l) => ({ ...l, creditNoteId: id })));
  const [row] = await s.tx
    .update(schema.creditNotes)
    .set({
      contactId,
      customerSnapshot: snapshot,
      invoiceId: input.invoiceId === undefined ? cn.invoiceId : input.invoiceId,
      issueDate: input.issueDate ?? cn.issueDate,
      reason: input.reason === undefined ? cn.reason : input.reason,
      documentDiscount: documentDiscount ?? null,
      ...totalsRow(computed),
      balance: computed.calc.total.toString(),
    })
    .where(and(eq(schema.creditNotes.id, id), eq(schema.creditNotes.version, input.version)))
    .returning();
  if (!row) throw versionConflict('Credit note');
  return getCreditNote(s, id);
}

export async function deleteDraftCreditNote(s: ServiceContext, id: string): Promise<void> {
  const cn = await loadCreditNote(s, id);
  if (cn.status !== 'draft') throw new ServiceError('immutable', 'Only drafts can be deleted');
  await s.tx.delete(schema.creditNotes).where(eq(schema.creditNotes.id, id));
  await recordAudit(s, { action: 'credit_note.draft_deleted', entityType: 'credit_note', entityId: id });
}

/**
 * Issue a credit note: Dr income (per line, net) + Dr tax payable / Cr customer
 * deposits and credits. The customer now holds a credit balance. Optionally
 * apply it straight to an invoice.
 */
export async function issueCreditNote(s: ServiceContext, id: string, input: IssueCreditNoteInput): Promise<CreditNoteDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const cn = await loadCreditNote(s, id, true);
    if (cn.status !== 'draft') throw new ServiceError('invalid_state', cn.status === 'void' ? 'This credit note is void.' : 'This credit note has already been issued.');
    if (cn.version !== input.version) throw versionConflict('Credit note');
    const cur = cn.currency;
    const total = Money.round(cn.total, cur);
    if (!total.isPositive()) throw new ServiceError('validation', 'The credit note total must be more than zero.');
    const snapshot = await snapshotCustomer(s, cn.contactId);
    const lines = await s.tx.select().from(schema.creditNoteLines).where(eq(schema.creditNoteLines.creditNoteId, id)).orderBy(asc(schema.creditNoteLines.lineNo));
    const deposits = await getAccountByRole(s, 'customer_deposits');
    const incomeByAccount = new Map<string, Money>();
    for (const l of lines) {
      const net = Money.round(l.net, cur);
      if (net.isZero()) continue;
      incomeByAccount.set(l.incomeAccountId, (incomeByAccount.get(l.incomeAccountId) ?? Money.zero(cur)).add(net));
    }
    const taxByAccount = new Map<string, Money>();
    for (const t of cn.taxSummary) {
      const amt = Money.of(t.amount, cur);
      if (amt.isZero()) continue;
      taxByAccount.set(t.liabilityAccountId, (taxByAccount.get(t.liabilityAccountId) ?? Money.zero(cur)).add(amt));
    }
    const entryLines: EntryLineInput[] = [];
    for (const [accountId, amt] of incomeByAccount) entryLines.push({ accountId, debit: amt, contactId: cn.contactId });
    for (const [accountId, amt] of taxByAccount) entryLines.push({ accountId, debit: amt, contactId: cn.contactId });
    entryLines.push({ accountId: deposits.id, credit: total, contactId: cn.contactId, memo: 'Customer credit' });
    const numberRes = await s.tx.execute<{ n: string }>(sql`select app.next_document_number(${s.ctx.companyId}::uuid, 'credit_note') as n`);
    const number = numberRes.rows[0]!.n;
    const entry = await postEntry(s, {
      date: cn.issueDate,
      memo: `Credit note ${number} — ${snapshot.name}`,
      sourceType: 'credit_note',
      sourceId: id,
      cashTreatment: 'derived',
      lines: entryLines,
    });
    const [row] = await s.tx
      .update(schema.creditNotes)
      .set({ number, status: 'issued', customerSnapshot: snapshot, journalEntryId: entry.id, issuedAt: new Date().toISOString(), issuedBy: s.ctx.actorId, balance: total.toString(), amountUsed: '0' })
      .where(and(eq(schema.creditNotes.id, id), eq(schema.creditNotes.version, input.version)))
      .returning();
    if (!row) throw versionConflict('Credit note');
    await recordAudit(s, { action: 'credit_note.issued', entityType: 'credit_note', entityId: id, details: { number, total: total.toString(), entryNumber: entry.entryNumber } });
    if (input.applyToInvoiceId) {
      const inv = await loadInvoiceForUpdate(s, input.applyToInvoiceId);
      const applyAmount = total.min(Money.round(inv.balanceDue, cur));
      if (applyAmount.isPositive()) {
        await applyCreditNote(s, id, { version: row.version, allocations: [{ invoiceId: inv.id, amount: applyAmount.toString() }], date: cn.issueDate });
      }
    }
    return getCreditNote(s, id);
  });
}

/**
 * Apply credit to invoices: Dr customer deposits / Cr AR. On the cash basis
 * this reclassifies (−credit-note components, +invoice components); no cash moved.
 */
export async function applyCreditNote(s: ServiceContext, id: string, input: ApplyCreditNoteInput): Promise<CreditNoteDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const cn = await loadCreditNote(s, id, true);
    if (cn.status !== 'issued') throw new ServiceError('invalid_state', cn.status === 'draft' ? 'Issue this credit note first.' : 'This credit note is void.');
    if (cn.version !== input.version) throw versionConflict('Credit note');
    const cur = cn.currency;
    const amounts = input.allocations.map((a) => Money.of(a.amount, cur));
    const total = Money.sum(amounts, cur);
    const balance = Money.round(cn.balance, cur);
    if (total.gt(balance)) throw new ServiceError('over_allocation', `Only ${plainMoney(balance, cur)} is left on this credit note.`);
    const date = input.date ?? cn.issueDate;
    if (date < cn.issueDate) throw new ServiceError('validation', 'The date can’t be before the credit note date.');
    const ar = await getAccountByRole(s, 'accounts_receivable');
    const deposits = await getAccountByRole(s, 'customer_deposits');
    const ids = [...new Set(input.allocations.map((a) => a.invoiceId))].sort();
    if (ids.length !== input.allocations.length) throw new ServiceError('validation', 'Each invoice can appear only once.');
    const invoices = new Map<string, Awaited<ReturnType<typeof loadInvoiceForUpdate>>>();
    for (const invId of ids) {
      const inv = await loadInvoiceForUpdate(s, invId);
      if (inv.contactId !== cn.contactId) throw new ServiceError('validation', `Invoice ${inv.number} belongs to a different customer`);
      invoices.set(invId, inv);
    }
    const entry = await postEntry(s, {
      date,
      memo: `Apply credit note ${cn.number} to invoices`,
      sourceType: 'allocation',
      sourceId: cn.id,
      cashTreatment: 'derived',
      lines: [
        { accountId: deposits.id, debit: total, contactId: cn.contactId },
        { accountId: ar.id, credit: total, contactId: cn.contactId },
      ],
    });
    const usedBefore = Money.round(cn.amountUsed, cur);
    for (const [i, a] of input.allocations.entries()) {
      await applyToInvoice(s, { invoice: invoices.get(a.invoiceId)!, amount: amounts[i]!, date, sourceType: 'credit_note', creditNoteId: cn.id, journalEntryId: entry.id, contactId: cn.contactId });
    }
    // de-recognize the used part of the credit note (negative income/tax)
    await recognizeSettlement(s, { documentType: 'credit_note', documentId: cn.id, cumulativeBefore: usedBefore, applied: total, date, eventType: 'credit_applied', eventId: entry.id, contactId: cn.contactId, journalEntryId: entry.id });
    const usedAfter = usedBefore.add(total);
    const newBalance = Money.round(cn.total, cur).subtract(usedAfter);
    await s.tx
      .update(schema.creditNotes)
      .set({ amountUsed: usedAfter.toString(), balance: newBalance.toString(), status: newBalance.isZero() ? 'paid' : 'issued' })
      .where(eq(schema.creditNotes.id, cn.id));
    await recordAudit(s, { action: 'credit_note.applied', entityType: 'credit_note', entityId: cn.id, details: { amount: total.toString(), entryNumber: entry.entryNumber } });
    return getCreditNote(s, cn.id);
  });
}

/** Mark part of a credit note as used (refund). Called by refunds.ts. */
export async function consumeCreditNote(s: ServiceContext, cn: CreditNoteRow, amount: Money, date: string, eventType: string, eventId: string, journalEntryId: string): Promise<void> {
  const cur = cn.currency;
  const usedBefore = Money.round(cn.amountUsed, cur);
  if (amount.gt(Money.round(cn.balance, cur))) throw new ServiceError('over_allocation', `Only ${plainMoney(Money.round(cn.balance, cur), cur)} is left on this credit note.`);
  await recognizeSettlement(s, { documentType: 'credit_note', documentId: cn.id, cumulativeBefore: usedBefore, applied: amount, date, eventType, eventId, contactId: cn.contactId, journalEntryId });
  const usedAfter = usedBefore.add(amount);
  const newBalance = Money.round(cn.total, cur).subtract(usedAfter);
  await s.tx
    .update(schema.creditNotes)
    .set({ amountUsed: usedAfter.toString(), balance: newBalance.toString(), status: newBalance.isZero() ? 'paid' : 'issued' })
    .where(eq(schema.creditNotes.id, cn.id));
}

export async function voidCreditNote(s: ServiceContext, id: string, input: VoidInvoiceInput): Promise<CreditNoteDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const cn = await loadCreditNote(s, id, true);
    if (cn.status === 'void') throw new ServiceError('invalid_state', 'This credit note is already void.');
    if (cn.status === 'draft') throw new ServiceError('invalid_state', 'A draft can’t be voided. Delete it instead.');
    if (cn.version !== input.version) throw versionConflict('Credit note');
    if (!Money.round(cn.amountUsed, cn.currency).isZero()) throw new ServiceError('invalid_state', 'Some of this credit has been used or refunded. Remove it from invoices and void the refunds first.');
    const date = input.date ?? cn.issueDate;
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, cn.journalEntryId!)).orderBy(asc(schema.journalLines.lineNo));
    const reversal = await postEntry(s, {
      date,
      memo: `Void credit note ${cn.number}: ${input.reason}`,
      sourceType: 'credit_note_void',
      sourceId: id,
      cashTreatment: 'derived',
      lines: reverseLines(lines.map((l) => ({ accountId: l.accountId, debit: Money.round(l.debit, cn.currency), credit: Money.round(l.credit, cn.currency), memo: l.memo, contactId: l.contactId }))),
      reversesEntryId: cn.journalEntryId,
    });
    await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, cn.journalEntryId!));
    await s.tx
      .update(schema.creditNotes)
      .set({ status: 'void', voidJournalEntryId: reversal.id, voidedAt: new Date().toISOString(), voidReason: input.reason, balance: '0', amountUsed: Money.round(cn.total, cn.currency).toString() })
      .where(eq(schema.creditNotes.id, id));
    await recordAudit(s, { action: 'credit_note.voided', entityType: 'credit_note', entityId: id, reason: input.reason });
    return getCreditNote(s, id);
  });
}

export { randomUUID };
