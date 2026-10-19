import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import type { DeleteRecordInput, DeleteRecordResultDto, DeletionBlocker, DeletionPreviewDto, DeletionTarget } from '@evenbooks/contracts';
import { ServiceError, notFound, periodLocked, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { rebuildCashRecognition, rederiveDocumentSettlement } from './recognition-rebuild';

/**
 * Permanent deletion of posted records, as if they never existed: the record,
 * its journal entries (including voids and reversals), allocations and cash
 * recognition are removed. Dependent records block the delete instead of being
 * removed with it; affected invoices and credit notes are recalculated, bank
 * lines go back to the inbox, and reconciliations that cleared deleted lines
 * are reopened. Closed periods and processor-originated records are never
 * touched. The audit trail keeps a snapshot of what was removed.
 *
 * The database guards allow these deletes only while `app.hard_delete` is set
 * for the transaction and the company has deletion enabled (0018_hard_delete).
 */

type EntryRow = typeof schema.journalEntries.$inferSelect;
type BankTxnRow = typeof schema.bankTransactions.$inferSelect;
type Doc = { type: 'invoice' | 'credit_note'; id: string };

/** Journal entries a user may delete directly; everything else belongs to a document. */
const STANDALONE_SOURCES = new Set(['manual', 'opening_balance', 'adjustment', 'import', 'transfer', 'bank_categorization']);
const BANK_SOURCES = new Set(['transfer', 'bank_categorization']);

interface Plan {
  target: DeletionTarget;
  label: string;
  version: number;
  snapshot: Record<string, unknown>;
  entryIds: Set<string>;
  blockers: DeletionBlocker[];
  /** Reviewed bank lines that go back to the inbox. */
  resetBankTxnIds: Set<string>;
  /** Surviving documents whose settlement is recomputed. */
  affectedDocs: Map<string, Doc & { label: string }>;
  /** Cash recognition rows to drop: by event id and by document. */
  recognitionEventIds: Set<string>;
  recognitionDocs: { type: string; id: string }[];
  customerFacing: boolean;
  /** Type-specific row changes, run before the entries are deleted. */
  remove: () => Promise<void>;
}

const cur = (s: ServiceContext) => s.company.baseCurrency;
const money = (s: ServiceContext, v: string) => Money.round(v, cur(s)).toString();

function newPlan(target: DeletionTarget, label: string, version: number, snapshot: Record<string, unknown>): Plan {
  return {
    target,
    label,
    version,
    snapshot,
    entryIds: new Set(),
    blockers: [],
    resetBankTxnIds: new Set(),
    affectedDocs: new Map(),
    recognitionEventIds: new Set(),
    recognitionDocs: [],
    customerFacing: false,
    remove: async () => {},
  };
}

function block(plan: Plan, code: string, message: string, record: DeletionBlocker['record'] = null) {
  plan.blockers.push({ code, message, record });
}

function addEntry(plan: Plan, id: string | null | undefined) {
  if (id) plan.entryIds.add(id);
}

function affect(plan: Plan, doc: Doc, label: string) {
  plan.affectedDocs.set(`${doc.type}:${doc.id}`, { ...doc, label });
}

async function loadEntries(s: ServiceContext, ids: Iterable<string>): Promise<EntryRow[]> {
  const list = [...new Set(ids)];
  if (!list.length) return [];
  return s.tx.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), inArray(schema.journalEntries.id, list)));
}

function paymentLabel(s: ServiceContext, p: { amount: string; date: string }) {
  return `Payment of ${money(s, p.amount)} on ${p.date}`;
}
function refundLabel(s: ServiceContext, r: { amount: string; date: string }) {
  return `Refund of ${money(s, r.amount)} on ${r.date}`;
}
function txnLabel(s: ServiceContext, t: { amount: string; date: string; description: string }) {
  return `${t.date} ${t.description} (${money(s, t.amount)})`;
}

// ---------------------------------------------------------------------------
// Collectors: what a delete removes and what blocks it
// ---------------------------------------------------------------------------

async function planInvoice(s: ServiceContext, id: string): Promise<Plan> {
  const [inv] = await s.tx.select().from(schema.invoices).where(and(eq(schema.invoices.companyId, s.ctx.companyId), eq(schema.invoices.id, id)));
  if (!inv) throw notFound('Invoice');
  const label = `Invoice ${inv.number ?? '(draft)'}`;
  const plan = newPlan({ type: 'invoice', id }, label, inv.version, { number: inv.number, status: inv.status, contactId: inv.contactId, issueDate: inv.issueDate, total: inv.total, customerSnapshot: inv.customerSnapshot });
  addEntry(plan, inv.journalEntryId);
  addEntry(plan, inv.voidJournalEntryId);
  plan.recognitionDocs.push({ type: 'invoice', id });

  const allocations = await s.tx
    .select({ payment: schema.payments, creditNote: schema.creditNotes })
    .from(schema.paymentAllocations)
    .leftJoin(schema.payments, eq(schema.payments.id, schema.paymentAllocations.paymentId))
    .leftJoin(schema.creditNotes, eq(schema.creditNotes.id, schema.paymentAllocations.creditNoteId))
    .where(eq(schema.paymentAllocations.invoiceId, id));
  const seen = new Set<string>();
  for (const { payment, creditNote } of allocations) {
    if (payment && !seen.has(payment.id)) {
      seen.add(payment.id);
      block(plan, 'applied_payment', `${paymentLabel(s, payment)} was applied to this invoice. Delete the payment first.`, { type: 'payment', id: payment.id, label: paymentLabel(s, payment) });
    } else if (creditNote && !seen.has(creditNote.id)) {
      seen.add(creditNote.id);
      block(plan, 'applied_credit', `Credit note ${creditNote.number} was applied to this invoice. Delete the credit note first.`, { type: 'credit_note', id: creditNote.id, label: `Credit note ${creditNote.number}` });
    }
  }
  const notes = await s.tx.select({ id: schema.creditNotes.id, number: schema.creditNotes.number }).from(schema.creditNotes).where(and(eq(schema.creditNotes.companyId, s.ctx.companyId), eq(schema.creditNotes.invoiceId, id)));
  for (const cn of notes) {
    if (seen.has(cn.id)) continue;
    block(plan, 'credit_note', `Credit note ${cn.number ?? '(draft)'} was issued against this invoice. Delete the credit note first.`, { type: 'credit_note', id: cn.id, label: `Credit note ${cn.number ?? '(draft)'}` });
  }
  const charges = await s.tx.select().from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), eq(schema.processorCharges.invoiceId, id)));
  const live = charges.filter((c) => c.paymentId || !['failed', 'canceled'].includes(c.status));
  if (live.length) block(plan, 'online_payment', 'This invoice has an online payment (pending or collected). Online payments cannot be deleted; refund them through the payment processor.');

  const emails = await s.tx.select({ id: schema.emailMessages.id }).from(schema.emailMessages).where(and(eq(schema.emailMessages.companyId, s.ctx.companyId), eq(schema.emailMessages.invoiceId, id)));
  plan.customerFacing = inv.status !== 'draft' && (emails.length > 0 || (inv.publicTokenHash !== null && inv.publicTokenRevokedAt === null));

  plan.remove = async () => {
    const pdfs = await s.tx.select({ attachmentId: schema.invoicePdfs.attachmentId }).from(schema.invoicePdfs).where(eq(schema.invoicePdfs.invoiceId, id));
    if (emails.length) await s.tx.delete(schema.emailMessages).where(inArray(schema.emailMessages.id, emails.map((e) => e.id)));
    await s.tx.delete(schema.invoicePdfs).where(eq(schema.invoicePdfs.invoiceId, id));
    const dead = charges.filter((c) => !live.includes(c));
    if (dead.length) await s.tx.delete(schema.processorCharges).where(inArray(schema.processorCharges.id, dead.map((c) => c.id)));
    await s.tx.update(schema.recurringSchedules).set({ createdFromInvoiceId: null }).where(and(eq(schema.recurringSchedules.companyId, s.ctx.companyId), eq(schema.recurringSchedules.createdFromInvoiceId, id)));
    await s.tx.delete(schema.invoices).where(eq(schema.invoices.id, id));
    await unlinkAttachments(s, 'invoice', id, pdfs.map((p) => p.attachmentId).concat(inv.currentPdfAttachmentId ? [inv.currentPdfAttachmentId] : []));
  };
  return plan;
}

async function planCreditNote(s: ServiceContext, id: string): Promise<Plan> {
  const [cn] = await s.tx.select().from(schema.creditNotes).where(and(eq(schema.creditNotes.companyId, s.ctx.companyId), eq(schema.creditNotes.id, id)));
  if (!cn) throw notFound('Credit note');
  const plan = newPlan({ type: 'credit_note', id }, `Credit note ${cn.number ?? '(draft)'}`, cn.version, { number: cn.number, status: cn.status, contactId: cn.contactId, issueDate: cn.issueDate, total: cn.total, invoiceId: cn.invoiceId });
  addEntry(plan, cn.journalEntryId);
  addEntry(plan, cn.voidJournalEntryId);
  plan.recognitionDocs.push({ type: 'credit_note', id });

  const refunds = await s.tx.select().from(schema.refunds).where(and(eq(schema.refunds.companyId, s.ctx.companyId), eq(schema.refunds.creditNoteId, id)));
  for (const r of refunds) block(plan, 'refund', `${refundLabel(s, r)} was paid from this credit note. Delete the refund first.`, { type: 'refund', id: r.id, label: refundLabel(s, r) });

  const allocations = await s.tx
    .select({ a: schema.paymentAllocations, number: schema.invoices.number })
    .from(schema.paymentAllocations)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.paymentAllocations.invoiceId))
    .where(eq(schema.paymentAllocations.creditNoteId, id));
  for (const { a, number } of allocations) {
    addEntry(plan, a.journalEntryId);
    addEntry(plan, a.reversalJournalEntryId);
    plan.recognitionEventIds.add(a.id);
    affect(plan, { type: 'invoice', id: a.invoiceId }, `Invoice ${number}`);
  }
  plan.remove = async () => {
    for (const { a } of allocations) if (a.status === 'active') await unsettleInvoice(s, a.invoiceId, a.amount);
    if (allocations.length) await s.tx.delete(schema.paymentAllocations).where(inArray(schema.paymentAllocations.id, allocations.map((x) => x.a.id)));
    await s.tx.delete(schema.creditNotes).where(eq(schema.creditNotes.id, id));
  };
  return plan;
}

async function planPayment(s: ServiceContext, id: string): Promise<Plan> {
  const [p] = await s.tx.select().from(schema.payments).where(and(eq(schema.payments.companyId, s.ctx.companyId), eq(schema.payments.id, id)));
  if (!p) throw notFound('Payment');
  const plan = newPlan({ type: 'payment', id }, paymentLabel(s, p), p.version, { date: p.date, amount: p.amount, contactId: p.contactId, method: p.method, reference: p.reference, status: p.status, depositAccountId: p.depositAccountId });
  addEntry(plan, p.journalEntryId);
  addEntry(plan, p.voidJournalEntryId);
  plan.recognitionDocs.push({ type: 'payment', id });
  plan.recognitionEventIds.add(id);

  const refunds = await s.tx.select().from(schema.refunds).where(and(eq(schema.refunds.companyId, s.ctx.companyId), eq(schema.refunds.paymentId, id)));
  for (const r of refunds) block(plan, 'refund', `${refundLabel(s, r)} was paid from this payment. Delete the refund first.`, { type: 'refund', id: r.id, label: refundLabel(s, r) });
  const [charge] = await s.tx.select({ id: schema.processorCharges.id }).from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), eq(schema.processorCharges.paymentId, id))).limit(1);
  const [procRefund] = await s.tx.select({ id: schema.processorRefunds.id }).from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.paymentId, id))).limit(1);
  if (charge || procRefund) block(plan, 'online_payment', 'This payment was collected online. Refund it through the payment processor instead.');

  const allocations = await s.tx
    .select({ a: schema.paymentAllocations, number: schema.invoices.number })
    .from(schema.paymentAllocations)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.paymentAllocations.invoiceId))
    .where(eq(schema.paymentAllocations.paymentId, id));
  for (const { a, number } of allocations) {
    addEntry(plan, a.journalEntryId);
    addEntry(plan, a.reversalJournalEntryId);
    plan.recognitionEventIds.add(a.id);
    affect(plan, { type: 'invoice', id: a.invoiceId }, `Invoice ${number}`);
  }
  // Allocation and allocation-reversal entries posted later carry the payment as source.
  const later = await s.tx
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), eq(schema.journalEntries.sourceId, id), inArray(schema.journalEntries.sourceType, ['allocation', 'allocation_reversal', 'payment_void'])));
  for (const e of later) addEntry(plan, e.id);
  await addBankMatches(s, plan, 'payment', id);
  plan.remove = async () => {
    for (const { a } of allocations) if (a.status === 'active') await unsettleInvoice(s, a.invoiceId, a.amount);
    if (allocations.length) await s.tx.delete(schema.paymentAllocations).where(inArray(schema.paymentAllocations.id, allocations.map((x) => x.a.id)));
    await s.tx.delete(schema.payments).where(eq(schema.payments.id, id));
  };
  return plan;
}

async function planRefund(s: ServiceContext, id: string): Promise<Plan> {
  const [r] = await s.tx.select().from(schema.refunds).where(and(eq(schema.refunds.companyId, s.ctx.companyId), eq(schema.refunds.id, id)));
  if (!r) throw notFound('Refund');
  const plan = newPlan({ type: 'refund', id }, refundLabel(s, r), 0, { date: r.date, amount: r.amount, sourceType: r.sourceType, paymentId: r.paymentId, creditNoteId: r.creditNoteId, status: r.status, fromAccountId: r.fromAccountId });
  addEntry(plan, r.journalEntryId);
  addEntry(plan, r.voidJournalEntryId);
  plan.recognitionEventIds.add(id);
  if (r.voidJournalEntryId) plan.recognitionEventIds.add(r.voidJournalEntryId);
  const [online] = await s.tx.select({ id: schema.processorRefunds.id }).from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.refundId, id))).limit(1);
  if (online) block(plan, 'online_refund', 'This refund was issued through the payment processor and mirrors money that already left.');
  let creditNote: typeof schema.creditNotes.$inferSelect | undefined;
  if (r.creditNoteId) {
    [creditNote] = await s.tx.select().from(schema.creditNotes).where(eq(schema.creditNotes.id, r.creditNoteId));
    if (creditNote) affect(plan, { type: 'credit_note', id: creditNote.id }, `Credit note ${creditNote.number}`);
  }
  await addBankMatches(s, plan, 'refund', id);
  plan.remove = async () => {
    if (r.status === 'posted') {
      const amount = Money.round(r.amount, cur(s));
      if (r.paymentId) {
        const [p] = await s.tx.select().from(schema.payments).where(eq(schema.payments.id, r.paymentId)).for('update');
        if (p) {
          await s.tx
            .update(schema.payments)
            .set({ amountRefunded: Money.round(p.amountRefunded, cur(s)).subtract(amount).toString(), unappliedAmount: Money.round(p.unappliedAmount, cur(s)).add(amount).toString() })
            .where(eq(schema.payments.id, p.id));
        }
      } else if (creditNote) {
        const [cn] = await s.tx.select().from(schema.creditNotes).where(eq(schema.creditNotes.id, creditNote.id)).for('update');
        const usedAfter = Money.round(cn!.amountUsed, cur(s)).subtract(amount);
        await s.tx
          .update(schema.creditNotes)
          .set({ amountUsed: usedAfter.toString(), balance: Money.round(cn!.total, cur(s)).subtract(usedAfter).toString(), ...(cn!.status === 'paid' && { status: 'issued' as const }) })
          .where(eq(schema.creditNotes.id, cn!.id));
      }
    }
    await s.tx.delete(schema.refunds).where(eq(schema.refunds.id, id));
  };
  return plan;
}

async function planPurchase(s: ServiceContext, id: string): Promise<Plan> {
  const [p] = await s.tx.select().from(schema.purchases).where(and(eq(schema.purchases.companyId, s.ctx.companyId), eq(schema.purchases.id, id)));
  if (!p) throw notFound('Purchase');
  const label = `${p.direction === 'outflow' ? 'Purchase' : 'Vendor refund'} of ${money(s, p.total)} on ${p.date}`;
  const plan = newPlan({ type: 'purchase', id }, label, p.version, { date: p.date, total: p.total, direction: p.direction, contactId: p.contactId, paidFromAccountId: p.paidFromAccountId, reference: p.reference, memo: p.memo, status: p.status });
  addEntry(plan, p.journalEntryId);
  addEntry(plan, p.voidJournalEntryId);
  if (p.bankTransactionId) plan.resetBankTxnIds.add(p.bankTransactionId);
  await addBankMatches(s, plan, 'purchase', id);
  plan.remove = async () => {
    await s.tx.delete(schema.purchases).where(eq(schema.purchases.id, id));
    await unlinkAttachments(s, 'purchase', id);
  };
  return plan;
}

async function rootEntry(s: ServiceContext, e: EntryRow): Promise<EntryRow> {
  let cur = e;
  for (let i = 0; cur.reversesEntryId && i < 50; i++) {
    const [parent] = await loadEntries(s, [cur.reversesEntryId]);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

async function planJournalEntry(s: ServiceContext, id: string): Promise<Plan> {
  const [e] = await loadEntries(s, [id]);
  if (!e) throw notFound('Journal entry');
  const plan = newPlan({ type: 'journal_entry', id }, `Journal entry ${e.entryNumber ? `#${e.entryNumber}` : '(draft)'}`, e.version, { entryNumber: e.entryNumber, date: e.date, memo: e.memo, sourceType: e.sourceType, status: e.status });
  addEntry(plan, id);
  const root = await rootEntry(s, e);
  if (!STANDALONE_SOURCES.has(root.sourceType)) {
    block(plan, 'document_entry', `This entry belongs to a ${root.sourceType.replace(/_/g, ' ')} record. Delete that record instead so its balances stay consistent.`, documentRecord(root));
  }
  await addBankMatches(s, plan, 'journal_entry', id);
  return plan;
}

function documentRecord(e: EntryRow): DeletionBlocker['record'] {
  if (!e.sourceId) return null;
  const type = e.sourceType.startsWith('invoice') ? 'invoice'
    : e.sourceType.startsWith('credit_note') ? 'credit_note'
    : e.sourceType.startsWith('payment') ? 'payment'
    : e.sourceType.startsWith('refund') ? 'refund'
    : e.sourceType.startsWith('purchase') ? 'purchase'
    : null;
  return type ? { type, id: e.sourceId, label: e.memo || type } : null;
}

async function planBankTransaction(s: ServiceContext, id: string): Promise<Plan> {
  const [t] = await s.tx.select().from(schema.bankTransactions).where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), eq(schema.bankTransactions.id, id)));
  if (!t) throw notFound('Bank transaction');
  const plan = newPlan({ type: 'bank_transaction', id }, `Bank transaction ${txnLabel(s, t)}`, t.version, { bankAccountId: t.bankAccountId, date: t.date, amount: t.amount, description: t.description, source: t.source, status: t.status, providerTxnId: t.providerTxnId, fingerprint: t.fingerprint });
  // Every entry this line ever created, including reviews that were undone.
  const own = await s.tx
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), eq(schema.journalEntries.sourceId, id), inArray(schema.journalEntries.sourceType, ['transfer', 'bank_categorization', 'reversal'])));
  for (const e of own) addEntry(plan, e.id);
  if (t.journalEntryId) {
    const [e] = await loadEntries(s, [t.journalEntryId]);
    if (e && BANK_SOURCES.has(e.sourceType)) addEntry(plan, e.id);
  }
  // Purchases created by categorizing this line (posted or voided by an undo).
  const purchases = await s.tx.select().from(schema.purchases).where(and(eq(schema.purchases.companyId, s.ctx.companyId), eq(schema.purchases.bankTransactionId, id)));
  for (const p of purchases) {
    addEntry(plan, p.journalEntryId);
    addEntry(plan, p.voidJournalEntryId);
    await addBankMatches(s, plan, 'purchase', p.id);
  }
  plan.remove = async () => {
    await s.tx.update(schema.payments).set({ bankTransactionId: null }).where(and(eq(schema.payments.companyId, s.ctx.companyId), eq(schema.payments.bankTransactionId, id)));
    await s.tx.update(schema.refunds).set({ bankTransactionId: null }).where(and(eq(schema.refunds.companyId, s.ctx.companyId), eq(schema.refunds.bankTransactionId, id)));
    await s.tx.update(schema.importRows).set({ bankTransactionId: null }).where(and(eq(schema.importRows.companyId, s.ctx.companyId), eq(schema.importRows.bankTransactionId, id)));
    if (purchases.length) {
      await s.tx.delete(schema.purchases).where(inArray(schema.purchases.id, purchases.map((p) => p.id)));
      for (const p of purchases) await unlinkAttachments(s, 'purchase', p.id);
    }
    await s.tx
      .insert(schema.deletedBankTransactions)
      .values({ companyId: s.ctx.companyId, bankAccountId: t.bankAccountId, providerTxnId: t.providerTxnId, fingerprint: t.fingerprint, date: t.date, amount: t.amount, description: t.description, deletedBy: s.ctx.actorId })
      .onConflictDoNothing();
    await s.tx.delete(schema.bankTransactions).where(eq(schema.bankTransactions.id, id));
  };
  return plan;
}

/** Bank lines matched to a record go back to the inbox when the record is deleted. */
async function addBankMatches(s: ServiceContext, plan: Plan, targetType: string, targetId: string) {
  const rows = await s.tx
    .select({ id: schema.transactionMatches.bankTransactionId })
    .from(schema.transactionMatches)
    .where(and(eq(schema.transactionMatches.companyId, s.ctx.companyId), sql`${schema.transactionMatches.targetType} = ${targetType}`, eq(schema.transactionMatches.targetId, targetId)));
  for (const r of rows) plan.resetBankTxnIds.add(r.id);
}

/**
 * Close the plan over reversal chains and bank lines: deleting an entry also
 * deletes its reversals (and what it reversed); bank lines pointing at any
 * deleted entry are reset, and resetting a line deletes the entries it posted
 * itself (categorization, transfer, deposit or fee entries).
 */
async function closePlan(s: ServiceContext, plan: Plan): Promise<BankTxnRow[]> {
  const deletingTxn = plan.target.type === 'bank_transaction' ? plan.target.id : null;
  const seenTxns = new Set<string>();
  const txns: BankTxnRow[] = [];
  for (let round = 0; round < 20; round++) {
    const before = plan.entryIds.size + plan.resetBankTxnIds.size;
    const entries = await loadEntries(s, plan.entryIds);
    for (const e of entries) {
      addEntry(plan, e.reversesEntryId);
      addEntry(plan, e.reversedByEntryId);
    }
    if (plan.entryIds.size) {
      const reversals = await s.tx.select({ id: schema.journalEntries.id }).from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), inArray(schema.journalEntries.reversesEntryId, [...plan.entryIds])));
      for (const r of reversals) addEntry(plan, r.id);
      const linked = await s.tx.select({ id: schema.bankTransactions.id }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), inArray(schema.bankTransactions.journalEntryId, [...plan.entryIds])));
      for (const t of linked) plan.resetBankTxnIds.add(t.id);
      const matched = await s.tx.select({ id: schema.transactionMatches.bankTransactionId }).from(schema.transactionMatches).where(and(eq(schema.transactionMatches.companyId, s.ctx.companyId), eq(schema.transactionMatches.targetType, 'journal_entry'), inArray(schema.transactionMatches.targetId, [...plan.entryIds])));
      for (const t of matched) plan.resetBankTxnIds.add(t.id);
    }
    if (deletingTxn) plan.resetBankTxnIds.delete(deletingTxn);
    const fresh = [...plan.resetBankTxnIds].filter((id) => !seenTxns.has(id));
    if (fresh.length) {
      const rows = await s.tx.select().from(schema.bankTransactions).where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), inArray(schema.bankTransactions.id, fresh)));
      for (const t of rows) {
        seenTxns.add(t.id);
        txns.push(t);
        // The line's current review: entries it posted itself and are still in effect.
        const own = await s.tx
          .select()
          .from(schema.journalEntries)
          .where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), eq(schema.journalEntries.sourceId, t.id), inArray(schema.journalEntries.sourceType, ['transfer', 'bank_categorization']), sql`${schema.journalEntries.reversedByEntryId} is null`));
        for (const e of own) addEntry(plan, e.id);
        if (t.journalEntryId) {
          const [e] = await loadEntries(s, [t.journalEntryId]);
          if (e && BANK_SOURCES.has(e.sourceType)) addEntry(plan, e.id);
        }
      }
    }
    if (plan.entryIds.size + plan.resetBankTxnIds.size === before) break;
  }
  // Records outside this delete that reference its entries block it.
  const ids = [...plan.entryIds];
  if (ids.length) {
    const procCharges = await s.tx.select({ id: schema.processorCharges.id }).from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), inArray(schema.processorCharges.feeJournalEntryId, ids))).limit(1);
    const procRefunds = await s.tx.select({ id: schema.processorRefunds.id }).from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), inArray(schema.processorRefunds.feeJournalEntryId, ids))).limit(1);
    const payouts = await s.tx.select({ id: schema.processorPayouts.id }).from(schema.processorPayouts).where(and(eq(schema.processorPayouts.companyId, s.ctx.companyId), or(inArray(schema.processorPayouts.journalEntryId, ids), inArray(schema.processorPayouts.reversalEntryId, ids)))).limit(1);
    if (procCharges.length || procRefunds.length || payouts.length) block(plan, 'processor_entry', 'Entries posted by the payment processor cannot be deleted.');
  }
  return txns;
}

async function buildPlan(s: ServiceContext, target: DeletionTarget): Promise<{ plan: Plan; txns: BankTxnRow[] }> {
  const plan =
    target.type === 'invoice' ? await planInvoice(s, target.id)
    : target.type === 'credit_note' ? await planCreditNote(s, target.id)
    : target.type === 'payment' ? await planPayment(s, target.id)
    : target.type === 'refund' ? await planRefund(s, target.id)
    : target.type === 'purchase' ? await planPurchase(s, target.id)
    : target.type === 'journal_entry' ? await planJournalEntry(s, target.id)
    : await planBankTransaction(s, target.id);
  const txns = await closePlan(s, plan);
  return { plan, txns };
}

// ---------------------------------------------------------------------------
// Shared row changes
// ---------------------------------------------------------------------------

/** Remove a settlement from an invoice that survives the delete. */
async function unsettleInvoice(s: ServiceContext, invoiceId: string, amount: string) {
  const [inv] = await s.tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId)).for('update');
  if (!inv || inv.status === 'void') return;
  const c = cur(s);
  const settled = Money.round(inv.amountSettled, c).subtract(Money.round(amount, c));
  if (settled.isNegative()) throw new ServiceError('internal', 'Settlement bookkeeping is inconsistent');
  const balance = Money.round(inv.total, c).subtract(settled);
  await s.tx
    .update(schema.invoices)
    .set({ amountSettled: settled.toString(), balanceDue: balance.toString(), status: balance.isZero() ? 'paid' : 'issued' })
    .where(eq(schema.invoices.id, invoiceId));
}

/** Detach files; the orphan cleanup job removes the stored objects. */
async function unlinkAttachments(s: ServiceContext, entityType: string, entityId: string, extraIds: string[] = []) {
  await s.tx
    .update(schema.attachments)
    .set({ entityType: null, entityId: null })
    .where(and(eq(schema.attachments.companyId, s.ctx.companyId), or(and(eq(schema.attachments.entityType, entityType), eq(schema.attachments.entityId, entityId)), extraIds.length ? inArray(schema.attachments.id, extraIds) : sql`false`)));
}

async function lockedDates(s: ServiceContext, dates: string[]): Promise<string[]> {
  const unique = [...new Set(dates)].sort();
  if (!unique.length) return [];
  const r = await s.tx.execute<{ d: string }>(sql`select v.d::text as d from (values ${sql.join(unique.map((d) => sql`(${d}::date)`), sql`, `)}) as v(d) where app.is_date_locked(${s.ctx.companyId}::uuid, v.d)`);
  return r.rows.map((x) => x.d);
}

async function affectedReconciliations(s: ServiceContext, entryIds: string[]) {
  if (!entryIds.length) return [];
  return s.tx
    .selectDistinct({ id: schema.reconciliationSessions.id, status: schema.reconciliationSessions.status, bankAccountId: schema.reconciliationSessions.bankAccountId, statementEndDate: schema.reconciliationSessions.statementEndDate, bankAccountName: schema.bankAccounts.name })
    .from(schema.reconciliationItems)
    .innerJoin(schema.journalLines, eq(schema.journalLines.id, schema.reconciliationItems.journalLineId))
    .innerJoin(schema.reconciliationSessions, eq(schema.reconciliationSessions.id, schema.reconciliationItems.sessionId))
    .innerJoin(schema.bankAccounts, eq(schema.bankAccounts.id, schema.reconciliationSessions.bankAccountId))
    .where(inArray(schema.journalLines.entryId, entryIds));
}

async function entrySummaries(s: ServiceContext, entryIds: string[]) {
  if (!entryIds.length) return [];
  const rows = await s.tx
    .select({ e: schema.journalEntries, debit: sql<string>`coalesce(sum(${schema.journalLines.debit}), 0)::text` })
    .from(schema.journalEntries)
    .leftJoin(schema.journalLines, eq(schema.journalLines.entryId, schema.journalEntries.id))
    .where(inArray(schema.journalEntries.id, entryIds))
    .groupBy(schema.journalEntries.id);
  return rows
    .map(({ e, debit }) => ({ id: e.id, entryNumber: e.entryNumber, date: e.date, memo: e.memo, amount: money(s, debit), sourceType: e.sourceType, status: e.status }))
    .sort((a, b) => (a.entryNumber ?? 0) - (b.entryNumber ?? 0));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function previewDeletion(s: ServiceContext, target: DeletionTarget): Promise<DeletionPreviewDto> {
  const { plan, txns } = await buildPlan(s, target);
  const entries = await entrySummaries(s, [...plan.entryIds]);
  const locked = await lockedDates(s, entries.filter((e) => e.status === 'posted').map((e) => e.date));
  const recs = await affectedReconciliations(s, [...plan.entryIds]);
  if (!s.company.transactionDeletionEnabled) plan.blockers.unshift({ code: 'disabled', message: 'Deleting transactions is turned off for this company. An administrator can turn it on in Settings → Company.', record: null });
  return {
    type: target.type,
    id: target.id,
    label: plan.label,
    version: plan.version,
    entries: entries.map(({ status: _status, ...e }) => e),
    blockers: plan.blockers,
    lockedDates: locked,
    reconciliations: recs.filter((r) => r.status !== 'in_progress').map((r) => ({ id: r.id, bankAccountName: r.bankAccountName, statementEndDate: r.statementEndDate, status: r.status })),
    bankTransactions: txns.map((t) => ({ id: t.id, date: t.date, description: t.description, amount: money(s, t.amount) })),
    affectedDocuments: [...plan.affectedDocs.values()].map(({ type, id, label }) => ({ type, id, label })),
    customerFacing: plan.customerFacing,
    canDelete: plan.blockers.length === 0 && locked.length === 0,
  };
}

export async function deleteRecord(s: ServiceContext, input: DeleteRecordInput): Promise<DeleteRecordResultDto> {
  return idempotent(s, input.idempotencyKey, input, async () => {
    if (!s.company.transactionDeletionEnabled) throw new ServiceError('forbidden', 'Deleting transactions is turned off for this company');
    const { plan, txns } = await buildPlan(s, input);
    if (plan.version !== input.version) throw versionConflict(plan.label);
    if (plan.blockers.length) throw new ServiceError('invalid_state', plan.blockers[0]!.message, { blockers: plan.blockers });
    const entryIds = [...plan.entryIds];
    const entries = await loadEntries(s, entryIds);
    const locked = await lockedDates(s, entries.filter((e) => e.status === 'posted').map((e) => e.date));
    if (locked.length) throw periodLocked(locked[0]!, { dates: locked });

    const snapshotEntries = await snapshotOf(s, entries);
    await s.tx.execute(sql`select set_config('app.hard_delete', 'on', true)`);

    // 1. Reconciliations: drop the cleared lines, reopen finished sessions.
    const recs = await affectedReconciliations(s, entryIds);
    let reopened = 0;
    if (recs.length) {
      const lineIds = s.tx.select({ id: schema.journalLines.id }).from(schema.journalLines).where(inArray(schema.journalLines.entryId, entryIds));
      await s.tx.delete(schema.reconciliationItems).where(inArray(schema.reconciliationItems.journalLineId, lineIds));
      for (const r of recs.filter((x) => x.status !== 'in_progress')) {
        const [open] = await s.tx
          .select({ id: schema.reconciliationSessions.id })
          .from(schema.reconciliationSessions)
          .where(and(eq(schema.reconciliationSessions.companyId, s.ctx.companyId), eq(schema.reconciliationSessions.bankAccountId, r.bankAccountId), eq(schema.reconciliationSessions.status, 'in_progress'), ne(schema.reconciliationSessions.id, r.id)));
        const reason = `${plan.label} was deleted`;
        // Only one session per account may be in progress; flag the rest for review.
        await s.tx
          .update(schema.reconciliationSessions)
          .set(open ? { status: 'flagged', flaggedReason: reason, flaggedAt: new Date().toISOString() } : { status: 'in_progress', completedAt: null, completedBy: null, flaggedReason: null, flaggedAt: null })
          .where(eq(schema.reconciliationSessions.id, r.id));
        await recordAudit(s, { action: open ? 'reconciliation.flagged' : 'reconciliation.reopened', entityType: 'reconciliation', entityId: r.id, reason });
        reopened++;
      }
    }

    // 2. Cash recognition rows that came from the deleted events.
    const recognitionConds = [];
    if (entryIds.length) recognitionConds.push(inArray(schema.cashRecognitions.journalEntryId, entryIds), inArray(schema.cashRecognitions.eventId, entryIds));
    if (plan.recognitionEventIds.size) recognitionConds.push(inArray(schema.cashRecognitions.eventId, [...plan.recognitionEventIds]));
    for (const d of plan.recognitionDocs) recognitionConds.push(and(eq(schema.cashRecognitions.documentType, d.type), eq(schema.cashRecognitions.documentId, d.id))!);
    if (recognitionConds.length) await s.tx.delete(schema.cashRecognitions).where(and(eq(schema.cashRecognitions.companyId, s.ctx.companyId), or(...recognitionConds)));

    // 3. Bank lines go back to the inbox.
    for (const t of txns) {
      await s.tx.delete(schema.transactionMatches).where(eq(schema.transactionMatches.bankTransactionId, t.id));
      await s.tx.update(schema.bankTransactions).set({ status: 'unreviewed', journalEntryId: null, excludedReason: null, reviewedAt: null, reviewedBy: null }).where(eq(schema.bankTransactions.id, t.id));
    }
    await s.tx.delete(schema.transactionMatches).where(and(eq(schema.transactionMatches.companyId, s.ctx.companyId), eq(schema.transactionMatches.targetId, input.id)));

    // 4. The record and its dependents, then every entry in one statement
    //    (reversal pairs reference each other; FKs are checked at statement end).
    await plan.remove();
    if (entryIds.length) await s.tx.delete(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), inArray(schema.journalEntries.id, entryIds)));
    await s.tx.execute(sql`select set_config('app.hard_delete', 'off', true)`);

    // 5. Recompute settlement recognition on documents that lost events. A
    //    company that ran a full rebuild has rows without event provenance, so
    //    targeted cleanup cannot find them; rebuild again from what survives.
    const [rebuilt] = await s.tx.select({ id: schema.cashRecognitions.id }).from(schema.cashRecognitions).where(and(eq(schema.cashRecognitions.companyId, s.ctx.companyId), eq(schema.cashRecognitions.eventType, 'rebuild'))).limit(1);
    if (rebuilt) await rebuildCashRecognition(s, `${plan.label} was deleted`);
    else for (const d of plan.affectedDocs.values()) await rederiveDocumentSettlement(s, d.type, d.id);

    await recordAudit(s, {
      action: `${input.type}.deleted`,
      entityType: input.type,
      entityId: input.id,
      reason: input.reason,
      details: {
        label: plan.label,
        record: plan.snapshot,
        entries: snapshotEntries,
        bankTransactionsReset: txns.map((t) => t.id),
        affectedDocuments: [...plan.affectedDocs.values()].map((d) => ({ type: d.type, id: d.id })),
        reconciliationsReopened: recs.filter((r) => r.status !== 'in_progress').map((r) => r.id),
      },
    });
    return { type: input.type, id: input.id, entriesDeleted: entryIds.length, reconciliationsReopened: reopened };
  });
}

async function snapshotOf(s: ServiceContext, entries: EntryRow[]) {
  if (!entries.length) return [];
  const lines = await s.tx.select().from(schema.journalLines).where(inArray(schema.journalLines.entryId, entries.map((e) => e.id)));
  return entries
    .sort((a, b) => (a.entryNumber ?? 0) - (b.entryNumber ?? 0))
    .map((e) => ({
      id: e.id,
      entryNumber: e.entryNumber,
      date: e.date,
      memo: e.memo,
      sourceType: e.sourceType,
      status: e.status,
      lines: lines.filter((l) => l.entryId === e.id).sort((a, b) => a.lineNo - b.lineNo).map((l) => ({ accountId: l.accountId, debit: money(s, l.debit), credit: money(s, l.credit), contactId: l.contactId, memo: l.memo })),
    }));
}
