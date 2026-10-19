import { eq, and, inArray, asc } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, allocateSettlement, type RecognitionComponent } from '@evenbooks/domain';
import type { ServiceContext } from './context';
import { getAccountByRole } from './accounts';

/**
 * Cash recognition layer. Every cash-basis P&L amount is a row in
 * `cash_recognitions`; see docs/financial-policy.md §4 for the rules.
 *
 * Two producers:
 *  1. `recognizeIncludedEntry` — journal entries with cash_treatment = 'include'
 *     (purchases, categorized bank lines, manual cash journals and their reversals).
 *  2. Settlement events on sales documents — `recognizeSettlement` allocates an
 *     applied amount proportionally across a document's income/tax components
 *     (cumulative, so partial settlements add up exactly), `recognizeAdvance`
 *     records unapplied customer funds as income (or removes them when applied /
 *     refunded).
 */

async function importedCashComponents(s: ServiceContext, entry: typeof schema.journalEntries.$inferSelect): Promise<schema.ImportCashComponent[] | null> {
  let current = entry;
  let negate = false;
  while (current.reversesEntryId) {
    const [parent] = await s.tx.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, current.reversesEntryId));
    if (!parent) return null;
    current = parent;
    negate = !negate;
  }
  return current.cashComponents?.map(c => ({ ...c, amount: (negate ? Money.of(c.amount, entry.currency).negate() : Money.of(c.amount, entry.currency)).toString() })) ?? null;
}

export async function recognizeIncludedEntry(s: ServiceContext, entryId: string): Promise<void> {
  const [entry] = await s.tx.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, entryId)).limit(1);
  if (!entry || entry.status !== 'posted') return;
  const components = await importedCashComponents(s, entry);
  if (components !== null) {
    if (components.length) await s.tx.insert(schema.cashRecognitions).values(components.map(c => ({
      companyId: s.ctx.companyId, date: entry.date, accountId: c.accountId, amount: c.amount,
      kind: c.kind, eventType: 'import_cash_review', eventId: entry.id,
      documentType: 'import', documentId: entry.sourceId, journalEntryId: entry.id,
    })));
    return;
  }
  if (entry.cashTreatment !== 'include') return;
  const lines = await s.tx
    .select({
      id: schema.journalLines.id,
      accountId: schema.journalLines.accountId,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
      contactId: schema.journalLines.contactId,
      type: schema.accounts.type,
    })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.journalLines.accountId))
    .where(and(eq(schema.journalLines.entryId, entryId), inArray(schema.accounts.type, ['income', 'expense'])));
  if (lines.length === 0) return;
  const cur = entry.currency;
  await s.tx.insert(schema.cashRecognitions).values(
    lines.map((l) => {
      const debit = Money.round(l.debit, cur);
      const credit = Money.round(l.credit, cur);
      const natural = l.type === 'expense' ? debit.subtract(credit) : credit.subtract(debit);
      return {
        companyId: s.ctx.companyId,
        date: entry.date,
        accountId: l.accountId,
        amount: natural.toString(),
        kind: l.type === 'expense' ? ('expense' as const) : ('income' as const),
        eventType: 'journal_include',
        eventId: entry.id,
        documentType: entry.sourceType,
        documentId: entry.sourceId,
        lineId: l.id,
        contactId: l.contactId,
        journalEntryId: entry.id,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Document components
// ---------------------------------------------------------------------------

/** Income (per line, net) and tax (per rate) components of an issued invoice or credit note. */
export async function documentComponents(s: ServiceContext, documentType: 'invoice' | 'credit_note', documentId: string): Promise<RecognitionComponent[]> {
  const cur = s.company.baseCurrency;
  const linesTable = documentType === 'invoice' ? schema.invoiceLines : schema.creditNoteLines;
  const fk = documentType === 'invoice' ? schema.invoiceLines.invoiceId : schema.creditNoteLines.creditNoteId;
  const lines = await s.tx
    .select({ id: linesTable.id, incomeAccountId: linesTable.incomeAccountId, net: linesTable.net, lineNo: linesTable.lineNo })
    .from(linesTable)
    .where(eq(fk, documentId))
    .orderBy(asc(linesTable.lineNo));
  const [doc] =
    documentType === 'invoice'
      ? await s.tx.select({ taxSummary: schema.invoices.taxSummary }).from(schema.invoices).where(eq(schema.invoices.id, documentId))
      : await s.tx.select({ taxSummary: schema.creditNotes.taxSummary }).from(schema.creditNotes).where(eq(schema.creditNotes.id, documentId));
  const components: RecognitionComponent[] = lines.map((l) => ({
    key: `line:${l.id}`,
    kind: 'income',
    accountId: l.incomeAccountId,
    amount: Money.round(l.net, cur),
    lineId: l.id,
  }));
  for (const t of doc?.taxSummary ?? []) {
    components.push({ key: `tax:${t.taxRateId}`, kind: 'tax', accountId: t.liabilityAccountId, amount: Money.of(t.amount, cur), taxRateId: t.taxRateId });
  }
  return components;
}

export interface SettlementRecognitionInput {
  documentType: 'invoice' | 'credit_note';
  documentId: string;
  /** Cumulative amount settled on the document before this event. */
  cumulativeBefore: Money;
  /** Signed amount applied by this event (negative to reverse). */
  applied: Money;
  date: string;
  eventType: string;
  eventId: string;
  contactId: string | null;
  journalEntryId: string | null;
}

/**
 * Proportional recognition of a settlement. Invoices recognize positive income
 * and tax; credit notes (contra documents) recognize the negative when used.
 */
export async function recognizeSettlement(s: ServiceContext, input: SettlementRecognitionInput): Promise<void> {
  if (input.applied.isZero()) return;
  const components = await documentComponents(s, input.documentType, input.documentId);
  const allocations = allocateSettlement(components, input.cumulativeBefore, input.applied);
  const sign = input.documentType === 'invoice' ? 1 : -1;
  const byKey = new Map(components.map((c) => [c.key, c]));
  const rows = allocations
    .filter((a) => !a.amount.isZero())
    .map((a) => {
      const c = byKey.get(a.key)!;
      return {
        companyId: s.ctx.companyId,
        date: input.date,
        accountId: c.accountId,
        amount: (sign === 1 ? a.amount : a.amount.negate()).toString(),
        kind: c.kind === 'tax' ? ('tax' as const) : ('income' as const),
        eventType: input.eventType,
        eventId: input.eventId,
        documentType: input.documentType,
        documentId: input.documentId,
        lineId: c.lineId ?? null,
        taxRateId: c.taxRateId ?? null,
        contactId: input.contactId,
        journalEntryId: input.journalEntryId,
      };
    });
  if (rows.length) await s.tx.insert(schema.cashRecognitions).values(rows);
}

export interface AdvanceRecognitionInput {
  /** Signed: positive when funds are received unapplied, negative when applied or refunded. */
  amount: Money;
  date: string;
  eventType: string;
  eventId: string;
  paymentId: string;
  contactId: string | null;
  journalEntryId: string | null;
}

/** Unapplied customer funds are cash-basis income (advance payments) unless flagged refundable. */
export async function recognizeAdvance(s: ServiceContext, input: AdvanceRecognitionInput): Promise<void> {
  if (input.amount.isZero()) return;
  const account = await getAccountByRole(s, 'advance_payments');
  await s.tx.insert(schema.cashRecognitions).values({
    companyId: s.ctx.companyId,
    date: input.date,
    accountId: account.id,
    amount: input.amount.toString(),
    kind: 'advance',
    eventType: input.eventType,
    eventId: input.eventId,
    documentType: 'payment',
    documentId: input.paymentId,
    contactId: input.contactId,
    journalEntryId: input.journalEntryId,
  });
}
