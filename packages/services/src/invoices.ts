import { getInvoicePresentation, snapshotInvoiceDesign } from './invoice-presentation';
import { and, asc, eq, gt, gte, ilike, inArray, lte, lt, or, sql } from 'drizzle-orm';
import { schema, withSystem, type Db } from '@evenbooks/db';
import { DEFAULT_INVOICE_BRANDING, Money, dueDateFor, reverseLines, todayInTimeZone, type EntryLineInput } from '@evenbooks/domain';
import { SecretBox, randomToken, sha256Hex } from '@evenbooks/integrations';
import { publicOnlinePaymentInfo } from './processor';
import type { BulkInvoiceItemResult, BulkInvoiceResultDto, CreateInvoiceInput, InvoiceDto, InvoiceSort, IssueInvoiceInput, ListInvoicesQuery, Page, PublicInvoiceDto, UpdateInvoiceInput, VoidInvoiceInput } from '@evenbooks/contracts';
import { keyset, type SortColumns } from './keyset';
import { ServiceError, notFound, translateDbError, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { postEntry } from './ledger';
import { getAccountByRole } from './accounts';
import { accountNames, computeDocument, lineRows, snapshotCustomer, toAllocationDto, toLineDto, totalsRow } from './documents';
import { enqueueOutbox } from './outbox';

type InvoiceRow = typeof schema.invoices.$inferSelect;

function isOverdue(inv: InvoiceRow, today: string): boolean {
  return inv.status === 'issued' && inv.dueDate < today && Money.round(inv.balanceDue, inv.currency).isPositive();
}

async function toDtos(s: ServiceContext, rows: InvoiceRow[], opts: { withLines: boolean; withAllocations: boolean }): Promise<InvoiceDto[]> {
  if (rows.length === 0) return [];
  const today = todayInTimeZone(s.company.timeZone);
  const ids = rows.map((r) => r.id);
  const contactIds = [...new Set(rows.map((r) => r.contactId))];
  const contacts = await s.tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts).where(inArray(schema.contacts.id, contactIds));
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const lines = opts.withLines ? await s.tx.select().from(schema.invoiceLines).where(inArray(schema.invoiceLines.invoiceId, ids)).orderBy(asc(schema.invoiceLines.lineNo)) : [];
  const names = await accountNames(
    s,
    lines.map((l) => l.incomeAccountId),
  );
  const allocations = opts.withAllocations
    ? await s.tx.select().from(schema.paymentAllocations).where(inArray(schema.paymentAllocations.invoiceId, ids)).orderBy(asc(schema.paymentAllocations.createdAt))
    : [];
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    isOverdue: isOverdue(r, today),
    contactId: r.contactId,
    contactName: contactName.get(r.contactId),
    customerSnapshot: r.customerSnapshot,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    termsDays: r.termsDays,
    memo: r.memo,
    footer: r.footer,
    paymentUrl: r.paymentUrl,
    onlinePaymentsDisabled: r.onlinePaymentsDisabled,
    documentDiscount: r.documentDiscount ?? null,
    currency: r.currency,
    subtotal: Money.round(r.subtotal, r.currency).toString(),
    discountTotal: Money.round(r.discountTotal, r.currency).toString(),
    netTotal: Money.round(r.netTotal, r.currency).toString(),
    taxTotal: Money.round(r.taxTotal, r.currency).toString(),
    total: Money.round(r.total, r.currency).toString(),
    taxSummary: r.taxSummary,
    amountSettled: Money.round(r.amountSettled, r.currency).toString(),
    balanceDue: Money.round(r.balanceDue, r.currency).toString(),
    journalEntryId: r.journalEntryId,
    voidJournalEntryId: r.voidJournalEntryId,
    voidReason: r.voidReason,
    recurringScheduleId: r.recurringScheduleId,
    recurringOccurrenceIndex: r.recurringOccurrenceIndex,
    hasPublicLink: Boolean(r.publicTokenHash) && !r.publicTokenRevokedAt,
    currentPdfAttachmentId: r.currentPdfAttachmentId,
    issuedAt: r.issuedAt,
    lastSentAt: r.lastSentAt,
    lines: lines.filter((l) => l.invoiceId === r.id).map((l) => toLineDto(l, r.currency, names.get(l.incomeAccountId))),
    allocations: opts.withAllocations
      ? allocations.filter((a) => a.invoiceId === r.id).map((a) => toAllocationDto(a, r.currency, { sourceLabel: a.sourceType === 'payment' ? 'Payment' : 'Credit note' }))
      : undefined,
    version: r.version,
    createdAt: r.createdAt,
  }));
}

export async function loadInvoice(s: ServiceContext, id: string, forUpdate = false): Promise<InvoiceRow> {
  const q = s.tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, s.ctx.companyId), eq(schema.invoices.id, id)))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Invoice');
  return row;
}

export async function getInvoice(s: ServiceContext, id: string): Promise<InvoiceDto> {
  const row = await loadInvoice(s, id);
  return (await toDtos(s, [row], { withLines: true, withAllocations: true }))[0]!;
}

const INVOICE_SORT_COLUMNS: SortColumns<InvoiceRow, InvoiceSort> = {
  issueDate: { expr: schema.invoices.issueDate, cast: 'date', value: (r) => r.issueDate },
  dueDate: { expr: schema.invoices.dueDate, cast: 'date', value: (r) => r.dueDate },
  // drafts have no number yet; they sort as ''
  number: { expr: sql`coalesce(${schema.invoices.number}, '')`, cast: 'text', value: (r) => r.number ?? '' },
  customer: { expr: sql`lower(coalesce(${schema.invoices.customerSnapshot}->>'name', ''))`, cast: 'text', value: (r) => (r.customerSnapshot?.name ?? '').toLowerCase() },
  total: { expr: schema.invoices.total, cast: 'numeric', value: (r) => r.total },
  balanceDue: { expr: schema.invoices.balanceDue, cast: 'numeric', value: (r) => r.balanceDue },
};

export async function listInvoices(s: ServiceContext, q: ListInvoicesQuery): Promise<Page<InvoiceDto>> {
  const today = todayInTimeZone(s.company.timeZone);
  const conds = [eq(schema.invoices.companyId, s.ctx.companyId)];
  if (q.status) conds.push(eq(schema.invoices.status, q.status));
  if (q.contactId) conds.push(eq(schema.invoices.contactId, q.contactId));
  if (q.from) conds.push(gte(schema.invoices.issueDate, q.from));
  if (q.to) conds.push(lte(schema.invoices.issueDate, q.to));
  if (q.outstanding) conds.push(eq(schema.invoices.status, 'issued'));
  if (q.overdue) conds.push(and(eq(schema.invoices.status, 'issued'), lt(schema.invoices.dueDate, today))!);
  if (q.q) conds.push(or(ilike(schema.invoices.number, `%${q.q}%`), ilike(schema.invoices.memo, `%${q.q}%`), sql`${schema.invoices.customerSnapshot}->>'name' ilike ${'%' + q.q + '%'}`)!);
  const sort = q.sort ?? 'issueDate';
  const ks = keyset({
    columns: INVOICE_SORT_COLUMNS,
    sort,
    dir: q.dir ?? (sort === 'number' || sort === 'customer' ? 'asc' : 'desc'),
    idColumn: schema.invoices.id,
    idOf: (r) => r.id,
    cursor: q.cursor,
  });
  const [{ total }] = (await s.tx.select({ total: sql<number>`count(*)::int` }).from(schema.invoices).where(and(...conds))) as [{ total: number }];
  const rows = await s.tx
    .select()
    .from(schema.invoices)
    .where(and(...conds, ks.after))
    .orderBy(...ks.orderBy)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  return { items: await toDtos(s, page, { withLines: false, withAllocations: false }), nextCursor: ks.next(rows, q.limit), total };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function createDraftInvoice(s: ServiceContext, input: CreateInvoiceInput): Promise<InvoiceDto> {
  const presentation = await getInvoicePresentation(s);
  const computed = await computeDocument(s, input.lines, input.documentDiscount);
  const snapshot = await snapshotCustomer(s, input.contactId);
  const termsDays = input.termsDays ?? s.company.defaultTermsDays;
  const dueDate = input.dueDate ?? dueDateFor(input.issueDate, termsDays);
  if (dueDate < input.issueDate) throw new ServiceError('validation', 'The due date can’t be before the issue date.');
  const [row] = await s.tx
    .insert(schema.invoices)
    .values({
      companyId: s.ctx.companyId,
      contactId: input.contactId,
      status: 'draft',
      currency: s.company.baseCurrency,
      issueDate: input.issueDate,
      dueDate,
      termsDays,
      customerSnapshot: snapshot,
      memo: input.memo === undefined ? presentation.branding.defaultNotes : input.memo,
      footer: input.footer === undefined ? presentation.branding.defaultFooter : input.footer,
      paymentUrl: input.paymentUrl ?? null,
      onlinePaymentsDisabled: input.onlinePaymentsDisabled ?? false,
      documentDiscount: input.documentDiscount ?? null,
      ...totalsRow(computed),
      balanceDue: computed.calc.total.toString(),
      createdBy: s.ctx.actorId,
    })
    .returning();
  await s.tx.insert(schema.invoiceLines).values(lineRows(s, computed).map((l) => ({ ...l, invoiceId: row!.id })));
  await recordAudit(s, { action: 'invoice.draft_created', entityType: 'invoice', entityId: row!.id, details: { total: computed.calc.total.toString() } });
  return getInvoice(s, row!.id);
}

export async function updateDraftInvoice(s: ServiceContext, id: string, input: UpdateInvoiceInput): Promise<InvoiceDto> {
  const inv = await loadInvoice(s, id);
  if (inv.status !== 'draft') throw new ServiceError('immutable', 'This invoice has been issued, so its lines can’t change. Void it or give a credit note instead.');
  if (inv.version !== input.version) throw versionConflict('Invoice');
  const currentLines = await s.tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, id)).orderBy(asc(schema.invoiceLines.lineNo));
  const lines = input.lines ?? currentLines.map((l) => ({
    itemId: l.itemId,
    description: l.description,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    discount: l.discount ?? null,
    incomeAccountId: l.incomeAccountId,
    taxRateIds: l.taxRateIds,
  }));
  const documentDiscount = input.documentDiscount === undefined ? inv.documentDiscount : input.documentDiscount;
  const computed = await computeDocument(s, lines, documentDiscount);
  const contactId = input.contactId ?? inv.contactId;
  const snapshot = contactId !== inv.contactId ? await snapshotCustomer(s, contactId) : inv.customerSnapshot;
  const issueDate = input.issueDate ?? inv.issueDate;
  const termsDays = input.termsDays ?? inv.termsDays;
  const dueDate = input.dueDate ?? (input.issueDate || input.termsDays !== undefined ? dueDateFor(issueDate, termsDays) : inv.dueDate);
  if (dueDate < issueDate) throw new ServiceError('validation', 'The due date can’t be before the issue date.');
  await s.tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, id));
  await s.tx.insert(schema.invoiceLines).values(lineRows(s, computed).map((l) => ({ ...l, invoiceId: id })));
  const [row] = await s.tx
    .update(schema.invoices)
    .set({
      contactId,
      customerSnapshot: snapshot,
      issueDate,
      dueDate,
      termsDays,
      memo: input.memo === undefined ? inv.memo : input.memo,
      footer: input.footer === undefined ? inv.footer : input.footer,
      paymentUrl: input.paymentUrl === undefined ? inv.paymentUrl : input.paymentUrl,
      onlinePaymentsDisabled: input.onlinePaymentsDisabled ?? inv.onlinePaymentsDisabled,
      documentDiscount: documentDiscount ?? null,
      ...totalsRow(computed),
      balanceDue: computed.calc.total.toString(),
    })
    .where(and(eq(schema.invoices.id, id), eq(schema.invoices.version, input.version)))
    .returning();
  if (!row) throw versionConflict('Invoice');
  await recordAudit(s, { action: 'invoice.draft_updated', entityType: 'invoice', entityId: id });
  return getInvoice(s, id);
}

export async function deleteDraftInvoice(s: ServiceContext, id: string): Promise<void> {
  const inv = await loadInvoice(s, id);
  if (inv.status !== 'draft') throw new ServiceError('immutable', 'Only drafts can be deleted');
  await s.tx.delete(schema.invoices).where(eq(schema.invoices.id, id));
  await recordAudit(s, { action: 'invoice.draft_deleted', entityType: 'invoice', entityId: id });
}

// ---------------------------------------------------------------------------
// Issue / void
// ---------------------------------------------------------------------------

export function tokenBox(): SecretBox | null {
  const key = process.env.APP_ENCRYPTION_KEY;
  return key ? new SecretBox(key) : null;
}

/**
 * Issue: allocate the number transactionally, snapshot the customer, post
 * Dr AR / Cr income per account / Cr tax payable per rate, create a public
 * link token, and enqueue PDF generation. Zero-total invoices cannot be issued.
 */
export async function issueInvoice(s: ServiceContext, id: string, input: IssueInvoiceInput): Promise<InvoiceDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const inv = await loadInvoice(s, id);
    if (inv.status !== 'draft') throw new ServiceError('invalid_state', inv.status === 'void' ? 'This invoice is void.' : 'This invoice has already been issued.');
    if (inv.version !== input.version) throw versionConflict('Invoice');
    const cur = inv.currency;
    const total = Money.round(inv.total, cur);
    if (!total.isPositive()) throw new ServiceError('validation', 'The invoice total must be more than zero to issue it.');
    const issueDate = input.issueDate ?? inv.issueDate;
    const dueDate = input.issueDate ? dueDateFor(issueDate, inv.termsDays) : inv.dueDate;
    const snapshot = await snapshotCustomer(s, inv.contactId);
    const lines = await s.tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, id)).orderBy(asc(schema.invoiceLines.lineNo));
    const ar = await getAccountByRole(s, 'accounts_receivable');

    const incomeByAccount = new Map<string, Money>();
    for (const l of lines) {
      const net = Money.round(l.net, cur);
      if (net.isZero()) continue;
      incomeByAccount.set(l.incomeAccountId, (incomeByAccount.get(l.incomeAccountId) ?? Money.zero(cur)).add(net));
    }
    const taxByAccount = new Map<string, Money>();
    for (const t of inv.taxSummary) {
      const amt = Money.of(t.amount, cur);
      if (amt.isZero()) continue;
      taxByAccount.set(t.liabilityAccountId, (taxByAccount.get(t.liabilityAccountId) ?? Money.zero(cur)).add(amt));
    }
    const entryLines: EntryLineInput[] = [{ accountId: ar.id, debit: total, contactId: inv.contactId, memo: `Invoice` }];
    for (const [accountId, amt] of incomeByAccount) entryLines.push({ accountId, credit: amt, contactId: inv.contactId });
    for (const [accountId, amt] of taxByAccount) {
      // negative net (credit-heavy discounts) cannot occur; tax can be negative only if net is negative, which is prevented by the calculator
      entryLines.push({ accountId, credit: amt, contactId: inv.contactId });
    }
    const numberRes = await s.tx.execute<{ n: string }>(sql`select app.next_document_number(${s.ctx.companyId}::uuid, 'invoice') as n`);
    const number = numberRes.rows[0]!.n;
    const entry = await postEntry(s, {
      date: issueDate,
      memo: `Invoice ${number} — ${snapshot.name}`,
      sourceType: 'invoice',
      sourceId: id,
      cashTreatment: 'derived',
      lines: entryLines,
    });
    const token = randomToken();
    const box = tokenBox();
    const [row] = await s.tx
      .update(schema.invoices)
      .set({
        number,
        status: 'issued',
        issueDate,
        dueDate,
        customerSnapshot: snapshot,
        designSnapshot: await snapshotInvoiceDesign(s),
        journalEntryId: entry.id,
        issuedAt: new Date().toISOString(),
        issuedBy: s.ctx.actorId,
        publicTokenHash: sha256Hex(token),
        publicTokenCiphertext: box ? box.encrypt(token) : null,
        balanceDue: total.toString(),
        amountSettled: '0',
      })
      .where(and(eq(schema.invoices.id, id), eq(schema.invoices.version, input.version)))
      .returning();
    if (!row) throw versionConflict('Invoice');
    await enqueueOutbox(s, 'invoice.issued', { invoiceId: id }, `invoice.issued:${id}`);
    await recordAudit(s, { action: 'invoice.issued', entityType: 'invoice', entityId: id, details: { number, total: total.toString(), entryNumber: entry.entryNumber } });
    return getInvoice(s, id);
  });
}

/** Per-item error for bulk commands: service errors are reported, anything unexpected aborts the request. */
export function bulkResultError(err: unknown): { code: string; message: string } {
  if (err instanceof ServiceError) return { code: err.code, message: err.message };
  const translated = translateDbError(err);
  if (translated) return { code: translated.code, message: translated.message };
  throw err;
}

/**
 * Issue many drafts. Each draft runs in its own savepoint with its own
 * idempotency key, so a closed period or a stale version fails only that
 * draft, and a retry replays the ones that went through.
 */
export async function bulkIssueInvoices(s: ServiceContext, items: { id: string; version: number; idempotencyKey: string }[]): Promise<BulkInvoiceResultDto> {
  const seen = new Set<string>();
  const results: BulkInvoiceItemResult[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      results.push({ id: item.id, number: null, ok: false, error: { code: 'duplicate', message: 'Listed more than once in this request' } });
      continue;
    }
    seen.add(item.id);
    try {
      const invoice = await s.tx.transaction((tx) => issueInvoice({ ...s, tx }, item.id, { version: item.version, idempotencyKey: item.idempotencyKey }));
      results.push({ id: item.id, number: invoice.number, ok: true, invoice });
    } catch (err) {
      results.push({ id: item.id, number: null, ok: false, error: bulkResultError(err) });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { action: 'issue', results, succeeded, failed: results.length - succeeded, skipped: 0 };
}

export async function updateIssuedInvoice(s: ServiceContext, id: string, input: { version: number; paymentUrl?: string | null; onlinePaymentsDisabled?: boolean }): Promise<InvoiceDto> {
  const inv = await loadInvoice(s, id);
  if (inv.status === 'draft') throw new ServiceError('validation', 'Use the draft editor for drafts');
  const [row] = await s.tx
    .update(schema.invoices)
    .set({ paymentUrl: input.paymentUrl === undefined ? inv.paymentUrl : input.paymentUrl, onlinePaymentsDisabled: input.onlinePaymentsDisabled ?? inv.onlinePaymentsDisabled })
    .where(and(eq(schema.invoices.id, id), eq(schema.invoices.version, input.version)))
    .returning();
  if (!row) throw versionConflict('Invoice');
  await recordAudit(s, { action: 'invoice.payment_url_updated', entityType: 'invoice', entityId: id });
  return getInvoice(s, id);
}

/** Void an issued invoice with no settlements: reversal entry, token revoked. */
export async function voidInvoice(s: ServiceContext, id: string, input: VoidInvoiceInput): Promise<InvoiceDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const inv = await loadInvoice(s, id);
    if (inv.status === 'void') throw new ServiceError('invalid_state', 'This invoice is already void.');
    if (inv.status === 'draft') throw new ServiceError('invalid_state', 'A draft can’t be voided. Delete it instead.');
    if (inv.version !== input.version) throw versionConflict('Invoice');
    if (!Money.round(inv.amountSettled, inv.currency).isZero()) {
      throw new ServiceError('invalid_state', 'Payments or credits have been applied to this invoice. Remove them from the invoice first, or give a credit note instead.');
    }
    const date = input.date ?? inv.issueDate;
    if (date < inv.issueDate) throw new ServiceError('validation', 'The void date can’t be before the issue date.');
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, inv.journalEntryId!)).orderBy(asc(schema.journalLines.lineNo));
    const reversal = await postEntry(s, {
      date,
      memo: `Void invoice ${inv.number}: ${input.reason}`,
      sourceType: 'invoice_void',
      sourceId: id,
      cashTreatment: 'derived',
      lines: reverseLines(lines.map((l) => ({ accountId: l.accountId, debit: Money.round(l.debit, inv.currency), credit: Money.round(l.credit, inv.currency), memo: l.memo, contactId: l.contactId }))),
      reversesEntryId: inv.journalEntryId,
    });
    await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, inv.journalEntryId!));
    const [row] = await s.tx
      .update(schema.invoices)
      .set({
        status: 'void',
        voidJournalEntryId: reversal.id,
        voidedAt: new Date().toISOString(),
        voidedBy: s.ctx.actorId,
        voidReason: input.reason,
        publicTokenRevokedAt: new Date().toISOString(),
        balanceDue: '0',
        amountSettled: Money.round(inv.total, inv.currency).toString(),
      })
      .where(and(eq(schema.invoices.id, id), eq(schema.invoices.version, input.version)))
      .returning();
    if (!row) throw versionConflict('Invoice');
    // pause any recurring schedule created from this invoice? no — schedules are independent
    await recordAudit(s, { action: 'invoice.voided', entityType: 'invoice', entityId: id, reason: input.reason, details: { reversalEntryId: reversal.id } });
    return getInvoice(s, id);
  });
}

// ---------------------------------------------------------------------------
// Public link
// ---------------------------------------------------------------------------

export async function getPublicLink(s: ServiceContext, id: string, baseUrl: string): Promise<{ url: string | null; path: string | null }> {
  const inv = await loadInvoice(s, id, true);
  if (inv.status === 'draft' || inv.status === 'void') throw new ServiceError('invalid_state', 'Only issued or paid invoices can have public links');
  if (inv.publicTokenRevokedAt) return { url: null, path: null };
  const box = tokenBox();
  if (!box) throw new ServiceError('internal', 'APP_ENCRYPTION_KEY is not configured; public links are unavailable');
  let token: string;
  if (inv.publicTokenCiphertext && !inv.publicTokenRevokedAt) {
    token = box.decrypt(inv.publicTokenCiphertext);
  } else {
    token = randomToken();
    await s.tx
      .update(schema.invoices)
      .set({ publicTokenHash: sha256Hex(token), publicTokenCiphertext: box.encrypt(token), publicTokenRevokedAt: null })
      .where(eq(schema.invoices.id, id));
    await recordAudit(s, { action: 'invoice.public_link_created', entityType: 'invoice', entityId: id });
  }
  const path = `/i/${token}`;
  return { url: `${baseUrl.replace(/\/$/, '')}${path}`, path };
}

export async function rotatePublicLink(s: ServiceContext, id: string, baseUrl: string): Promise<{ url: string; path: string }> {
  const inv = await loadInvoice(s, id, true);
  if (inv.status === 'draft' || inv.status === 'void') throw new ServiceError('invalid_state', 'Only issued or paid invoices can have public links');
  const token = randomToken();
  const box = tokenBox();
  if (!box) throw new ServiceError('internal', 'APP_ENCRYPTION_KEY is not configured');
  await s.tx.update(schema.invoices).set({ publicTokenHash: sha256Hex(token), publicTokenCiphertext: box.encrypt(token), publicTokenRevokedAt: null }).where(eq(schema.invoices.id, id));
  await recordAudit(s, { action: 'invoice.public_link_rotated', entityType: 'invoice', entityId: id });
  const path = `/i/${token}`;
  return { url: `${baseUrl.replace(/\/$/, '')}${path}`, path };
}

export async function revokePublicLink(s: ServiceContext, id: string): Promise<void> {
  await loadInvoice(s, id, true);
  await s.tx.update(schema.invoices).set({ publicTokenRevokedAt: new Date().toISOString() }).where(eq(schema.invoices.id, id));
  await recordAudit(s, { action: 'invoice.public_link_revoked', entityType: 'invoice', entityId: id });
}

/**
 * Customer-facing lookup by token (system context; no session). Exposes only the
 * fields a customer needs. Voided or revoked links return null.
 */
export async function getPublicInvoice(db: Db, token: string): Promise<{ dto: PublicInvoiceDto; invoiceId: string; companyId: string; pdfAttachmentId: string | null } | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const hash = sha256Hex(token);
  return withSystem(db, async (tx) => {
    const [inv] = await tx.select().from(schema.invoices).where(eq(schema.invoices.publicTokenHash, hash)).limit(1);
    if (!inv || inv.publicTokenRevokedAt || inv.status === 'draft' || inv.status === 'void') return null;
    await tx.execute(sql`select set_config('app.company_id', ${inv.companyId}, true)`);
    const [company] = await tx.select().from(schema.companies).where(eq(schema.companies.id, inv.companyId));
    const lines = await tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id)).orderBy(asc(schema.invoiceLines.lineNo));
    const cur = inv.currency;
    const today = todayInTimeZone(company!.timeZone);
    return {
      invoiceId: inv.id,
      companyId: inv.companyId,
      pdfAttachmentId: inv.currentPdfAttachmentId,
      dto: {
        number: inv.number!,
        status: inv.status as 'issued' | 'paid' | 'void',
        isOverdue: isOverdue(inv, today),
        issueDate: inv.issueDate,
        dueDate: inv.dueDate,
        company: inv.designSnapshot?.issuer ?? { name: company!.name, email: company!.email, phone: company!.phone, address: company!.address },
        branding: inv.designSnapshot ? { ...DEFAULT_INVOICE_BRANDING, ...inv.designSnapshot.branding } : undefined,
        customer: inv.customerSnapshot,
        lines: lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          lineDiscount: Money.round(l.lineDiscount, cur).toString(),
          taxTotal: Money.round(l.taxTotal, cur).toString(),
          net: Money.round(l.net, cur).toString(),
          total: Money.round(l.total, cur).toString(),
        })),
        currency: cur,
        subtotal: Money.round(inv.subtotal, cur).toString(),
        discountTotal: Money.round(inv.discountTotal, cur).toString(),
        taxSummary: inv.taxSummary.map((t) => ({ name: t.name, rate: t.rate, amount: t.amount })),
        taxTotal: Money.round(inv.taxTotal, cur).toString(),
        total: Money.round(inv.total, cur).toString(),
        amountSettled: Money.round(inv.amountSettled, cur).toString(),
        balanceDue: Money.round(inv.balanceDue, cur).toString(),
        memo: inv.memo,
        footer: inv.footer,
        paymentUrl: inv.paymentUrl,
        pdfAvailable: Boolean(inv.currentPdfAttachmentId),
        onlinePayment: await publicOnlinePaymentInfo({ tx, ctx: { companyId: inv.companyId, actorId: 'public', actorType: 'system' }, company: company! }, inv),
      },
    };
  });
}

/** Open invoices for a customer, oldest due first (used by payment allocation UI). */
export async function openInvoicesForContact(s: ServiceContext, contactId: string) {
  const today = todayInTimeZone(s.company.timeZone);
  const rows = await s.tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, s.ctx.companyId), eq(schema.invoices.contactId, contactId), eq(schema.invoices.status, 'issued'), gt(schema.invoices.balanceDue, '0')))
    .orderBy(asc(schema.invoices.dueDate), asc(schema.invoices.issueDate));
  return rows.map((r) => ({
    id: r.id,
    number: r.number!,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    total: Money.round(r.total, r.currency).toString(),
    balanceDue: Money.round(r.balanceDue, r.currency).toString(),
    isOverdue: isOverdue(r, today),
  }));
}

/** Object to stream for the public PDF link (current version only). */
export async function getPublicInvoicePdfObject(db: Db, token: string): Promise<{ objectKey: string; fileName: string } | null> {
  const found = await getPublicInvoice(db, token);
  if (!found || !found.pdfAttachmentId) return null;
  return withSystem(db, async (tx) => {
    const [a] = await tx.select({ objectKey: schema.attachments.objectKey, fileName: schema.attachments.fileName, companyId: schema.attachments.companyId }).from(schema.attachments).where(eq(schema.attachments.id, found.pdfAttachmentId!));
    if (!a || a.companyId !== found.companyId) return null;
    return { objectKey: a.objectKey, fileName: a.fileName };
  });
}
