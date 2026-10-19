import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, allocateSettlement } from '@evenbooks/domain';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { documentComponents } from './recognition';
import { getAccountByRole } from './accounts';

/**
 * Rebuild / verify the cash recognition layer from source events.
 *
 * The live services insert recognition rows as events happen. This module
 * derives the same rows purely from persisted documents, journal entries,
 * allocations and refunds — ordered by journal entry number — so the layer is
 * provably reproducible. `verify` diffs the derivation against the table;
 * `rebuild` replaces the table contents (append-only trigger blocks updates,
 * not deletes; the rebuild is audited).
 */
type Row = { date: string; accountId: string; amount: Money; kind: 'income' | 'tax' | 'expense' | 'advance' };

async function derive(s: ServiceContext): Promise<Row[]> {
  const cur = s.company.baseCurrency;
  const rows: Row[] = [];
  const companyId = s.ctx.companyId;

  // 1. Included journal entries (purchases, bank categorizations, manual cash journals, reversals)
  const included = await s.tx.execute<{ date: string; account_id: string; type: string; debit: string; credit: string }>(sql`
    select e.date::text as date, l.account_id, a.type::text as type, l.debit::text, l.credit::text
      from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
     where e.company_id = ${companyId} and e.status = 'posted' and e.cash_treatment = 'include' and e.cash_components is null
       and not exists (with recursive ancestors as (
         select id, reverses_entry_id, cash_components from journal_entries where id=e.reverses_entry_id
         union all select o.id, o.reverses_entry_id, o.cash_components from journal_entries o join ancestors p on o.id=p.reverses_entry_id
       ) select 1 from ancestors where cash_components is not null) and a.type in ('income','expense')
     order by e.entry_number, l.line_no`);
  for (const r of included.rows) {
    const d = Money.round(r.debit, cur);
    const c = Money.round(r.credit, cur);
    rows.push({ date: r.date, accountId: r.account_id, amount: r.type === 'expense' ? d.subtract(c) : c.subtract(d), kind: r.type === 'expense' ? 'expense' : 'income' });
  }

  const reviewed = await s.tx.execute<{ date: string; components: schema.ImportCashComponent[]; depth: number }>(sql`
    with recursive reviewed_entries as (
      select id, date, cash_components as components, 0 as depth from journal_entries
      where company_id=${companyId} and status='posted' and cash_components is not null
      union all
      select e.id, e.date, r.components, r.depth+1 from journal_entries e join reviewed_entries r on e.reverses_entry_id=r.id
      where e.company_id=${companyId} and e.status='posted'
    ) select date::text, components, depth from reviewed_entries`);
  for (const e of reviewed.rows) for (const c of e.components) {
    const amount = Money.of(c.amount, cur);
    rows.push({ date: e.date, accountId: c.accountId, amount: e.depth % 2 ? amount.negate() : amount, kind: c.kind });
  }

  // 2. Settlement events per document, ordered by the entry number that carried them
  const entryNumber = new Map<string, number>();
  const entries = await s.tx.select({ id: schema.journalEntries.id, n: schema.journalEntries.entryNumber, date: schema.journalEntries.date }).from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.status, 'posted')));
  const entryDate = new Map<string, string>();
  for (const e of entries) {
    entryNumber.set(e.id, e.n ?? 0);
    entryDate.set(e.id, e.date);
  }
  const payments = await s.tx.select().from(schema.payments).where(eq(schema.payments.companyId, companyId));
  const paymentById = new Map(payments.map((p) => [p.id, p]));
  const allocations = await s.tx.select().from(schema.paymentAllocations).where(eq(schema.paymentAllocations.companyId, companyId));
  const refunds = await s.tx.select().from(schema.refunds).where(eq(schema.refunds.companyId, companyId));

  type Ev = { order: number; date: string; documentType: 'invoice' | 'credit_note'; documentId: string; amount: Money };
  const docEvents = new Map<string, Ev[]>();
  const push = (key: string, ev: Ev) => {
    if (!docEvents.has(key)) docEvents.set(key, []);
    docEvents.get(key)!.push(ev);
  };
  for (const a of allocations) {
    const carrier = a.journalEntryId ?? (a.paymentId ? paymentById.get(a.paymentId)?.journalEntryId : null);
    const order = carrier ? entryNumber.get(carrier) ?? 0 : 0;
    const amt = Money.round(a.amount, cur);
    push(`invoice:${a.invoiceId}`, { order, date: a.date, documentType: 'invoice', documentId: a.invoiceId, amount: amt });
    if (a.sourceType === 'credit_note' && a.creditNoteId) push(`credit_note:${a.creditNoteId}`, { order, date: a.date, documentType: 'credit_note', documentId: a.creditNoteId, amount: amt });
    if (a.status === 'reversed' && a.reversalJournalEntryId) {
      const rn = entryNumber.get(a.reversalJournalEntryId) ?? 0;
      const rd = entryDate.get(a.reversalJournalEntryId) ?? a.date;
      push(`invoice:${a.invoiceId}`, { order: rn, date: rd, documentType: 'invoice', documentId: a.invoiceId, amount: amt.negate() });
    }
  }
  for (const r of refunds) {
    if (r.sourceType !== 'credit_note' || !r.creditNoteId) continue;
    const amt = Money.round(r.amount, cur);
    push(`credit_note:${r.creditNoteId}`, { order: entryNumber.get(r.journalEntryId) ?? 0, date: r.date, documentType: 'credit_note', documentId: r.creditNoteId, amount: amt });
    if (r.status === 'void' && r.voidJournalEntryId) push(`credit_note:${r.creditNoteId}`, { order: entryNumber.get(r.voidJournalEntryId) ?? 0, date: entryDate.get(r.voidJournalEntryId) ?? r.date, documentType: 'credit_note', documentId: r.creditNoteId, amount: amt.negate() });
  }
  for (const [, evs] of docEvents) {
    evs.sort((a, b) => a.order - b.order);
    const first = evs[0]!;
    const components = await documentComponents(s, first.documentType, first.documentId);
    const sign = first.documentType === 'invoice' ? 1 : -1;
    let cumulative = Money.zero(cur);
    for (const ev of evs) {
      const allocs = allocateSettlement(components, cumulative, ev.amount);
      for (const [i, a] of allocs.entries()) {
        if (a.amount.isZero()) continue;
        const c = components[i]!;
        rows.push({ date: ev.date, accountId: c.accountId, amount: sign === 1 ? a.amount : a.amount.negate(), kind: c.kind === 'tax' ? 'tax' : 'income' });
      }
      cumulative = cumulative.add(ev.amount);
    }
  }

  // 3. Advance payments (non-refundable unapplied customer funds)
  const advance = await getAccountByRole(s, 'advance_payments');
  for (const p of payments) {
    if (p.isRefundableDeposit) continue;
    const amount = Money.round(p.amount, cur);
    const own = allocations.filter((a) => a.paymentId === p.id && a.journalEntryId === null);
    const ownTotal = Money.sum(own.map((a) => Money.round(a.amount, cur)), cur);
    const initialUnapplied = amount.subtract(ownTotal);
    if (!initialUnapplied.isZero()) rows.push({ date: p.date, accountId: advance.id, amount: initialUnapplied, kind: 'advance' });
    for (const a of allocations.filter((x) => x.paymentId === p.id && x.journalEntryId !== null)) {
      const amt = Money.round(a.amount, cur);
      rows.push({ date: a.date, accountId: advance.id, amount: amt.negate(), kind: 'advance' });
    }
    for (const a of allocations.filter((x) => x.paymentId === p.id && x.status === 'reversed' && x.reversalJournalEntryId)) {
      rows.push({ date: entryDate.get(a.reversalJournalEntryId!) ?? a.date, accountId: advance.id, amount: Money.round(a.amount, cur), kind: 'advance' });
    }
    for (const r of refunds.filter((x) => x.paymentId === p.id)) {
      const amt = Money.round(r.amount, cur);
      rows.push({ date: r.date, accountId: advance.id, amount: amt.negate(), kind: 'advance' });
      if (r.status === 'void' && r.voidJournalEntryId) rows.push({ date: entryDate.get(r.voidJournalEntryId) ?? r.date, accountId: advance.id, amount: amt, kind: 'advance' });
    }
    if (p.status === 'void' && p.voidJournalEntryId) {
      const remaining = Money.round(p.unappliedAmount, cur);
      if (!remaining.isZero()) rows.push({ date: entryDate.get(p.voidJournalEntryId) ?? p.date, accountId: advance.id, amount: remaining.negate(), kind: 'advance' });
    }
  }
  return rows.filter((r) => !r.amount.isZero());
}

/**
 * Replace one document's settlement recognition with a fresh derivation from
 * its surviving allocations and refunds (same ordering as `derive`). Used after
 * a permanent delete removes some of a document's settlement events: cumulative
 * proportional allocation means the remaining events' rows must be recomputed.
 */
export async function rederiveDocumentSettlement(s: ServiceContext, documentType: 'invoice' | 'credit_note', documentId: string): Promise<void> {
  const cur = s.company.baseCurrency;
  const companyId = s.ctx.companyId;
  await s.tx
    .delete(schema.cashRecognitions)
    .where(and(eq(schema.cashRecognitions.companyId, companyId), eq(schema.cashRecognitions.documentType, documentType), eq(schema.cashRecognitions.documentId, documentId), sql`${schema.cashRecognitions.eventType} not in ('journal_include', 'import_cash_review')`));
  const allocations = await s.tx
    .select()
    .from(schema.paymentAllocations)
    .where(and(eq(schema.paymentAllocations.companyId, companyId), documentType === 'invoice' ? eq(schema.paymentAllocations.invoiceId, documentId) : eq(schema.paymentAllocations.creditNoteId, documentId)));
  const refunds = documentType === 'credit_note' ? await s.tx.select().from(schema.refunds).where(and(eq(schema.refunds.companyId, companyId), eq(schema.refunds.creditNoteId, documentId))) : [];
  const entryIds = new Set<string>();
  for (const a of allocations) {
    if (a.journalEntryId) entryIds.add(a.journalEntryId);
    if (a.reversalJournalEntryId) entryIds.add(a.reversalJournalEntryId);
  }
  for (const r of refunds) {
    entryIds.add(r.journalEntryId);
    if (r.voidJournalEntryId) entryIds.add(r.voidJournalEntryId);
  }
  const paymentIds = [...new Set(allocations.map((a) => a.paymentId).filter((x): x is string => Boolean(x)))];
  const payments = paymentIds.length ? await s.tx.select({ id: schema.payments.id, journalEntryId: schema.payments.journalEntryId }).from(schema.payments).where(inArray(schema.payments.id, paymentIds)) : [];
  const paymentEntry = new Map(payments.map((p) => [p.id, p.journalEntryId]));
  for (const p of payments) entryIds.add(p.journalEntryId);
  const entries = entryIds.size ? await s.tx.select({ id: schema.journalEntries.id, n: schema.journalEntries.entryNumber, date: schema.journalEntries.date }).from(schema.journalEntries).where(inArray(schema.journalEntries.id, [...entryIds])) : [];
  const entryNumber = new Map(entries.map((e) => [e.id, e.n ?? 0]));
  const entryDate = new Map(entries.map((e) => [e.id, e.date]));

  type Ev = { order: number; date: string; amount: Money; eventType: string; eventId: string; journalEntryId: string | null };
  const evs: Ev[] = [];
  for (const a of allocations) {
    const carrier = a.journalEntryId ?? (a.paymentId ? paymentEntry.get(a.paymentId) : null) ?? null;
    const amount = Money.round(a.amount, cur);
    const order = carrier ? entryNumber.get(carrier) ?? 0 : 0;
    if (documentType === 'invoice') {
      evs.push({ order, date: a.date, amount, eventType: a.sourceType === 'payment' ? 'payment_allocation' : 'credit_allocation', eventId: a.id, journalEntryId: a.journalEntryId });
      if (a.status === 'reversed' && a.reversalJournalEntryId) {
        evs.push({ order: entryNumber.get(a.reversalJournalEntryId) ?? 0, date: entryDate.get(a.reversalJournalEntryId) ?? a.date, amount: amount.negate(), eventType: 'allocation_reversal', eventId: a.id, journalEntryId: a.reversalJournalEntryId });
      }
    } else {
      evs.push({ order, date: a.date, amount, eventType: 'credit_applied', eventId: a.journalEntryId ?? a.id, journalEntryId: a.journalEntryId });
    }
  }
  for (const r of refunds) {
    const amount = Money.round(r.amount, cur);
    evs.push({ order: entryNumber.get(r.journalEntryId) ?? 0, date: r.date, amount, eventType: 'refund', eventId: r.id, journalEntryId: r.journalEntryId });
    if (r.status === 'void' && r.voidJournalEntryId) evs.push({ order: entryNumber.get(r.voidJournalEntryId) ?? 0, date: entryDate.get(r.voidJournalEntryId) ?? r.date, amount: amount.negate(), eventType: 'refund_void', eventId: r.voidJournalEntryId, journalEntryId: r.voidJournalEntryId });
  }
  if (evs.length === 0) return;
  evs.sort((a, b) => a.order - b.order);
  const [doc] =
    documentType === 'invoice'
      ? await s.tx.select({ contactId: schema.invoices.contactId }).from(schema.invoices).where(eq(schema.invoices.id, documentId))
      : await s.tx.select({ contactId: schema.creditNotes.contactId }).from(schema.creditNotes).where(eq(schema.creditNotes.id, documentId));
  const components = await documentComponents(s, documentType, documentId);
  const sign = documentType === 'invoice' ? 1 : -1;
  let cumulative = Money.zero(cur);
  const rows: (typeof schema.cashRecognitions.$inferInsert)[] = [];
  for (const ev of evs) {
    for (const [i, a] of allocateSettlement(components, cumulative, ev.amount).entries()) {
      if (a.amount.isZero()) continue;
      const c = components[i]!;
      rows.push({
        companyId,
        date: ev.date,
        accountId: c.accountId,
        amount: (sign === 1 ? a.amount : a.amount.negate()).toString(),
        kind: c.kind === 'tax' ? 'tax' : 'income',
        eventType: ev.eventType,
        eventId: ev.eventId,
        documentType,
        documentId,
        lineId: c.lineId ?? null,
        taxRateId: c.taxRateId ?? null,
        contactId: doc?.contactId ?? null,
        journalEntryId: ev.journalEntryId,
      });
    }
    cumulative = cumulative.add(ev.amount);
  }
  if (rows.length) await s.tx.insert(schema.cashRecognitions).values(rows);
}

function totalsByKey(rows: { date: string; accountId: string; amount: Money }[], cur: string): Map<string, Money> {
  const m = new Map<string, Money>();
  for (const r of rows) {
    const k = `${r.date}|${r.accountId}`;
    m.set(k, (m.get(k) ?? Money.zero(cur)).add(r.amount));
  }
  return m;
}

export interface RecognitionDiff {
  date: string;
  accountId: string;
  stored: string;
  derived: string;
}

export async function verifyCashRecognition(s: ServiceContext): Promise<{ ok: boolean; diffs: RecognitionDiff[]; storedRows: number; derivedRows: number }> {
  const cur = s.company.baseCurrency;
  const derived = await derive(s);
  const stored = await s.tx.select({ date: schema.cashRecognitions.date, accountId: schema.cashRecognitions.accountId, amount: schema.cashRecognitions.amount }).from(schema.cashRecognitions).where(eq(schema.cashRecognitions.companyId, s.ctx.companyId));
  const a = totalsByKey(derived, cur);
  const b = totalsByKey(stored.map((r) => ({ ...r, amount: Money.round(r.amount, cur) })), cur);
  const diffs: RecognitionDiff[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const d = a.get(k) ?? Money.zero(cur);
    const st = b.get(k) ?? Money.zero(cur);
    if (!d.equals(st)) {
      const [date, accountId] = k.split('|');
      diffs.push({ date: date!, accountId: accountId!, stored: st.toString(), derived: d.toString() });
    }
  }
  return { ok: diffs.length === 0, diffs, storedRows: stored.length, derivedRows: derived.length };
}

export async function rebuildCashRecognition(s: ServiceContext, reason: string): Promise<{ rows: number }> {
  const derived = await derive(s);
  await s.tx.delete(schema.cashRecognitions).where(eq(schema.cashRecognitions.companyId, s.ctx.companyId));
  if (derived.length) {
    await s.tx.insert(schema.cashRecognitions).values(
      derived.map((r) => ({ companyId: s.ctx.companyId, date: r.date, accountId: r.accountId, amount: r.amount.toString(), kind: r.kind, eventType: 'rebuild', eventId: s.ctx.companyId, documentType: null, documentId: null })),
    );
  }
  await recordAudit(s, { action: 'cash_recognition.rebuilt', entityType: 'company', entityId: s.ctx.companyId, reason, details: { rows: derived.length } });
  return { rows: derived.length };
}

export { asc };
