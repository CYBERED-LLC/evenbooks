import { randomUUID } from 'node:crypto';
import { and, asc, eq, gte, ilike, inArray, lte, or, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, reverseLines, type EntryLineInput } from '@evenbooks/domain';
import { PURCHASE_SORTS, type CreatePurchaseInput, type ListPurchasesQuery, type Page, type PurchaseDto, type VoidPurchaseInput } from '@evenbooks/contracts';
import { keyset, type SortColumns } from './keyset';
import { ServiceError, notFound, plainDate, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { postEntry, flagReconciliationsForEntry } from './ledger';
import { getAccount } from './accounts';
import { attachTo, listAttachmentsFor } from './attachments';

type PurchaseRow = typeof schema.purchases.$inferSelect;

/**
 * Paid purchases: money already left a bank account or was charged to a card.
 *   outflow: Dr expense/asset lines, Cr paid-from account
 *   inflow (vendor refund): Dr paid-from account, Cr expense/asset lines
 * Cash treatment is 'include' at the purchase date (card charges count when charged).
 */
export async function createPurchase(s: ServiceContext, input: CreatePurchaseInput): Promise<PurchaseDto> {
  return idempotent(s, input.idempotencyKey, input, async () => {
    const cur = s.company.baseCurrency;
    const paidFrom = await getAccount(s, input.paidFromAccountId);
    if (!(paidFrom.role === 'bank' || paidFrom.role === 'credit_card' || paidFrom.role === 'undeposited_funds' || paidFrom.type === 'asset' || paidFrom.type === 'liability')) {
      throw new ServiceError('validation', 'Pick the bank account or card you paid with, not a category.');
    }
    if (paidFrom.role === 'accounts_receivable' || paidFrom.role === 'customer_deposits' || paidFrom.role === 'sales_tax_payable') {
      throw new ServiceError('validation', 'Pick the bank account or card you paid with.');
    }
    const lineAccounts = await s.tx
      .select()
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, s.ctx.companyId), inArray(schema.accounts.id, [...new Set(input.lines.map((l) => l.accountId))])));
    const byId = new Map(lineAccounts.map((a) => [a.id, a]));
    for (const l of input.lines) {
      const a = byId.get(l.accountId);
      if (!a) throw new ServiceError('validation', 'One of the categories no longer exists. Pick it again.');
      if (a.role === 'accounts_receivable' || a.role === 'customer_deposits' || a.role === 'sales_tax_payable') {
        throw new ServiceError('validation', `${a.name} is managed by Evenbooks and can’t be used on a purchase. Pick an expense category.`);
      }
      if (a.id === paidFrom.id) throw new ServiceError('validation', `${a.name} is the account you paid from, so it can’t also be the category. Pick what the money was spent on.`);
    }
    if (input.contactId) {
      const [c] = await s.tx.select({ id: schema.contacts.id }).from(schema.contacts).where(and(eq(schema.contacts.companyId, s.ctx.companyId), eq(schema.contacts.id, input.contactId)));
      if (!c) throw new ServiceError('validation', 'That vendor no longer exists. Pick another one.');
    }
    const amounts = input.lines.map((l) => Money.of(l.amount, cur));
    const total = Money.sum(amounts, cur);
    const lines: EntryLineInput[] = [
      ...input.lines.map((l, i) => ({ accountId: l.accountId, debit: amounts[i]!, memo: l.description || null, contactId: input.contactId ?? null })),
      { accountId: paidFrom.id, credit: total, memo: input.memo ?? null, contactId: input.contactId ?? null },
    ];
    const entryLines = input.direction === 'outflow' ? lines : reverseLines(lines.map((l) => ({ accountId: l.accountId, debit: l.debit ?? Money.zero(cur), credit: l.credit ?? Money.zero(cur), memo: l.memo ?? null, contactId: l.contactId ?? null })));

    const purchaseId = randomUUID();
    const entry = await postEntry(s, {
      date: input.date,
      memo: input.memo || `${input.direction === 'outflow' ? 'Purchase' : 'Vendor refund'}${input.reference ? ` ${input.reference}` : ''}`,
      sourceType: 'purchase',
      sourceId: purchaseId,
      cashTreatment: 'include',
      lines: entryLines,
    });
    const [row] = await s.tx
      .insert(schema.purchases)
      .values({
        id: purchaseId,
        companyId: s.ctx.companyId,
        contactId: input.contactId ?? null,
        date: input.date,
        currency: cur,
        direction: input.direction,
        paidFromAccountId: paidFrom.id,
        reference: input.reference ?? null,
        memo: input.memo ?? null,
        total: total.toString(),
        journalEntryId: entry.id,
        bankTransactionId: input.bankTransactionId ?? null,
        createdBy: s.ctx.actorId,
      })
      .returning();
    await s.tx.insert(schema.purchaseLines).values(
      input.lines.map((l, i) => ({
        companyId: s.ctx.companyId,
        purchaseId: row!.id,
        lineNo: i + 1,
        accountId: l.accountId,
        description: l.description,
        amount: amounts[i]!.toString(),
      })),
    );
    if (input.attachmentIds.length) await attachTo(s, input.attachmentIds, 'purchase', row!.id);
    await recordAudit(s, { action: 'purchase.created', entityType: 'purchase', entityId: row!.id, details: { total: total.toString(), entryNumber: entry.entryNumber } });
    return getPurchase(s, row!.id);
  });
}

export async function voidPurchase(s: ServiceContext, id: string, input: VoidPurchaseInput): Promise<PurchaseDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const p = await loadPurchase(s, id);
    if (p.status === 'void') throw new ServiceError('invalid_state', 'This expense is already void.');
    if (p.version !== input.version) throw versionConflict('Purchase');
    const date = input.date ?? p.date;
    if (date < p.date) throw new ServiceError('validation', `The void date can’t be before the expense date (${plainDate(p.date)}).`);
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, p.journalEntryId)).orderBy(asc(schema.journalLines.lineNo));
    const reversal = await postEntry(s, {
      date,
      memo: `Void purchase: ${input.reason}`,
      sourceType: 'purchase_void',
      sourceId: p.id,
      cashTreatment: 'include',
      lines: reverseLines(
        lines.map((l) => ({
          accountId: l.accountId,
          debit: Money.round(l.debit, p.currency),
          credit: Money.round(l.credit, p.currency),
          memo: l.memo,
          contactId: l.contactId,
        })),
      ),
      reversesEntryId: p.journalEntryId,
    });
    await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, p.journalEntryId));
    const [row] = await s.tx
      .update(schema.purchases)
      .set({ status: 'void', voidJournalEntryId: reversal.id, voidedAt: new Date().toISOString(), voidReason: input.reason })
      .where(and(eq(schema.purchases.id, id), eq(schema.purchases.version, input.version)))
      .returning();
    if (!row) throw versionConflict('Purchase');
    if (p.bankTransactionId) {
      // the bank line needs review again
      await s.tx
        .update(schema.bankTransactions)
        .set({ status: 'unreviewed', journalEntryId: null, reviewedAt: null, reviewedBy: null })
        .where(eq(schema.bankTransactions.id, p.bankTransactionId));
      await s.tx.delete(schema.transactionMatches).where(and(eq(schema.transactionMatches.targetType, 'purchase'), eq(schema.transactionMatches.targetId, p.id)));
    }
    await flagReconciliationsForEntry(s, p.journalEntryId, `Purchase voided: ${input.reason}`);
    await recordAudit(s, { action: 'purchase.voided', entityType: 'purchase', entityId: id, reason: input.reason, details: { reversalEntryId: reversal.id } });
    return getPurchase(s, id);
  });
}

async function loadPurchase(s: ServiceContext, id: string): Promise<PurchaseRow> {
  const [row] = await s.tx
    .select()
    .from(schema.purchases)
    .where(and(eq(schema.purchases.companyId, s.ctx.companyId), eq(schema.purchases.id, id)))
    .limit(1);
  if (!row) throw notFound('Purchase');
  return row;
}

async function toDtos(s: ServiceContext, rows: PurchaseRow[], withAttachments: boolean): Promise<PurchaseDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const lines = await s.tx
    .select({
      id: schema.purchaseLines.id,
      purchaseId: schema.purchaseLines.purchaseId,
      lineNo: schema.purchaseLines.lineNo,
      accountId: schema.purchaseLines.accountId,
      description: schema.purchaseLines.description,
      amount: schema.purchaseLines.amount,
      accountName: schema.accounts.name,
      accountCode: schema.accounts.code,
    })
    .from(schema.purchaseLines)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.purchaseLines.accountId))
    .where(inArray(schema.purchaseLines.purchaseId, ids))
    .orderBy(asc(schema.purchaseLines.lineNo));
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => Boolean(x)))];
  const contacts = contactIds.length ? await s.tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts).where(inArray(schema.contacts.id, contactIds)) : [];
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const paidFromIds = [...new Set(rows.map((r) => r.paidFromAccountId))];
  const paidFrom = await s.tx.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(inArray(schema.accounts.id, paidFromIds));
  const paidFromName = new Map(paidFrom.map((a) => [a.id, a.name]));
  const out: PurchaseDto[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      date: r.date,
      contactId: r.contactId,
      contactName: r.contactId ? contactName.get(r.contactId) ?? null : null,
      direction: r.direction,
      paidFromAccountId: r.paidFromAccountId,
      paidFromAccountName: paidFromName.get(r.paidFromAccountId),
      reference: r.reference,
      memo: r.memo,
      total: Money.round(r.total, r.currency).toString(),
      currency: r.currency,
      status: r.status,
      journalEntryId: r.journalEntryId,
      voidJournalEntryId: r.voidJournalEntryId,
      bankTransactionId: r.bankTransactionId,
      voidReason: r.voidReason,
      lines: lines
        .filter((l) => l.purchaseId === r.id)
        .map((l) => ({ id: l.id, lineNo: l.lineNo, accountId: l.accountId, accountName: l.accountName, accountCode: l.accountCode, description: l.description, amount: Money.round(l.amount, r.currency).toString() })),
      attachments: withAttachments ? (await listAttachmentsFor(s, 'purchase', r.id)).map((a) => ({ id: a.id, fileName: a.fileName, contentType: a.contentType, sizeBytes: a.sizeBytes })) : undefined,
      version: r.version,
      createdAt: r.createdAt,
    });
  }
  return out;
}

export async function getPurchase(s: ServiceContext, id: string): Promise<PurchaseDto> {
  const row = await loadPurchase(s, id);
  return (await toDtos(s, [row], true))[0]!;
}

type PurchaseListRow = { p: PurchaseRow; vendorSort: string };

// Vendor sorts by the contact's current name, case-insensitively; no vendor sorts as ''.
const vendorSortExpr = sql<string>`lower(coalesce(${schema.contacts.name}, ''))`;

const PURCHASE_SORT_COLUMNS: SortColumns<PurchaseListRow, (typeof PURCHASE_SORTS)[number]> = {
  date: { expr: schema.purchases.date, cast: 'date', value: (r) => r.p.date },
  total: { expr: schema.purchases.total, cast: 'numeric', value: (r) => r.p.total },
  vendor: { expr: vendorSortExpr, cast: 'text', value: (r) => r.vendorSort },
  reference: { expr: sql`coalesce(${schema.purchases.reference}, '')`, cast: 'text', value: (r) => r.p.reference ?? '' },
};

export async function listPurchases(s: ServiceContext, q: ListPurchasesQuery): Promise<Page<PurchaseDto>> {
  const conds = [eq(schema.purchases.companyId, s.ctx.companyId)];
  if (q.from) conds.push(gte(schema.purchases.date, q.from));
  if (q.to) conds.push(lte(schema.purchases.date, q.to));
  if (q.contactId) conds.push(eq(schema.purchases.contactId, q.contactId));
  if (q.status) conds.push(eq(schema.purchases.status, q.status));
  if (q.q) conds.push(or(ilike(schema.purchases.memo, `%${q.q}%`), ilike(schema.purchases.reference, `%${q.q}%`))!);
  if (q.accountId) {
    // Any account the purchase touches: the paid-from account or a line account.
    conds.push(
      or(
        eq(schema.purchases.paidFromAccountId, q.accountId),
        sql`exists (select 1 from ${schema.purchaseLines} pl where pl.purchase_id = ${schema.purchases.id} and pl.account_id = ${q.accountId})`,
      )!,
    );
  }
  const ks = keyset({
    columns: PURCHASE_SORT_COLUMNS,
    sort: q.sort ?? 'date',
    dir: q.dir ?? 'desc',
    idColumn: schema.purchases.id,
    idOf: (r) => r.p.id,
    cursor: q.cursor,
  });
  const [{ total }] = (await s.tx.select({ total: sql<number>`count(*)::int` }).from(schema.purchases).where(and(...conds))) as [{ total: number }];
  const rows: PurchaseListRow[] = await s.tx
    .select({ p: schema.purchases, vendorSort: vendorSortExpr })
    .from(schema.purchases)
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.purchases.contactId))
    .where(and(...conds, ks.after))
    .orderBy(...ks.orderBy)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit).map((r) => r.p);
  return { items: await toDtos(s, page, false), nextCursor: ks.next(rows, q.limit), total };
}
