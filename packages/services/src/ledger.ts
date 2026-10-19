import { and, asc, eq, gte, ilike, inArray, lte, sql } from 'drizzle-orm';
import { schema, type JournalSource, type CashTreatment } from '@evenbooks/db';
import { keyset, type SortColumns } from './keyset';
import {
  Money,
  normalizeEntryLines,
  reverseLines,
  isDebitNormal,
  PROTECTED_CONTROL_ROLES,
  type NormalizedLine,
  type EntryLineInput,
} from '@evenbooks/domain';
import { JOURNAL_SORTS } from '@evenbooks/contracts';
import type {
  Page,
  CreateManualJournalInput,
  JournalEntryDto,
  JournalLineDto,
  ListJournalQuery,
  OpeningBalancesInput,
  ReverseJournalInput,
  UpdateDraftJournalInput,
} from '@evenbooks/contracts';
import { ServiceError, notFound, periodLocked, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { recognizeIncludedEntry } from './recognition';
import { getAccountByRole } from './accounts';

type EntryRow = typeof schema.journalEntries.$inferSelect;
type LineRow = typeof schema.journalLines.$inferSelect;

// ---------------------------------------------------------------------------
// Internal posting primitive used by every document service
// ---------------------------------------------------------------------------

export interface PostEntryInput {
  date: string;
  memo: string;
  sourceType: JournalSource;
  sourceId?: string | null;
  cashTreatment: CashTreatment;
  lines: readonly EntryLineInput[];
  cashComponents?: schema.ImportCashComponent[] | null;
  reversesEntryId?: string | null;
  idempotencyKey?: string | null;
}

async function assertNotLocked(s: ServiceContext, date: string): Promise<void> {
  const r = await s.tx.execute<{ locked: boolean }>(sql`select app.is_date_locked(${s.ctx.companyId}::uuid, ${date}::date) as locked`);
  if (r.rows[0]?.locked) throw periodLocked(date);
}

async function loadAccounts(s: ServiceContext, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const rows = await s.tx
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, s.ctx.companyId), inArray(schema.accounts.id, unique)));
  const byId = new Map(rows.map((a) => [a.id, a]));
  for (const id of unique) {
    const a = byId.get(id);
    if (!a) throw new ServiceError('validation', 'One of the chosen accounts no longer exists. Reload the page and pick again.');
    if (!a.isActive) throw new ServiceError('validation', `Account ${a.code} ${a.name} is archived`);
    if (a.currency !== s.company.baseCurrency) throw new ServiceError('validation', `Account ${a.code} is not in ${s.company.baseCurrency}`);
  }
  return byId;
}

function validateLines(s: ServiceContext, lines: readonly EntryLineInput[]): NormalizedLine[] {
  try {
    return normalizeEntryLines(lines, s.company.baseCurrency);
  } catch (err) {
    const e = err as Error;
    throw new ServiceError(e.name === 'UnbalancedEntryError' ? 'unbalanced' : 'validation', e.message);
  }
}

async function insertLines(s: ServiceContext, entryId: string, lines: readonly NormalizedLine[]): Promise<void> {
  await s.tx.insert(schema.journalLines).values(
    lines.map((l, i) => ({
      companyId: s.ctx.companyId,
      entryId,
      lineNo: i + 1,
      accountId: l.accountId,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      memo: l.memo,
      contactId: l.contactId,
    })),
  );
}

/**
 * Atomically create and post a balanced entry. Validates in the service, then
 * relies on the database (deferred trigger) as the final check.
 */
export async function postEntry(s: ServiceContext, input: PostEntryInput): Promise<EntryRow> {
  const lines = validateLines(s, input.lines);
  const accounts = await loadAccounts(
    s,
    lines.map((l) => l.accountId),
  );
  if (input.sourceType === 'manual') {
    for (const l of lines) {
      const a = accounts.get(l.accountId)!;
      if (a.role && PROTECTED_CONTROL_ROLES.has(a.role)) {
        throw new ServiceError('validation', `${a.name} changes only through invoices, payments and credit notes, so a journal entry can’t use it. For money tracked outside Evenbooks, use a separate account.`);
      }
    }
  }
  await assertNotLocked(s, input.date);
  const [draft] = await s.tx
    .insert(schema.journalEntries)
    .values({
      companyId: s.ctx.companyId,
      date: input.date,
      memo: input.memo,
      status: 'draft',
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      currency: s.company.baseCurrency,
      cashTreatment: input.cashTreatment,
      cashComponents: input.cashComponents ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      createdBy: s.ctx.actorId,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning();
  await insertLines(s, draft!.id, lines);
  return markPosted(s, draft!.id);
}

async function markPosted(s: ServiceContext, entryId: string): Promise<EntryRow> {
  const num = await s.tx.execute<{ n: string }>(sql`select app.next_journal_number(${s.ctx.companyId}::uuid) as n`);
  const [posted] = await s.tx
    .update(schema.journalEntries)
    .set({ status: 'posted', postedAt: new Date().toISOString(), postedBy: s.ctx.actorId, entryNumber: Number(num.rows[0]!.n) })
    .where(eq(schema.journalEntries.id, entryId))
    .returning();
  // Ask the database to validate now rather than at commit so callers get the error here.
  await s.tx.execute(sql`set constraints all immediate`);
  await s.tx.execute(sql`set constraints all deferred`);
  await recognizeIncludedEntry(s, entryId);
  return posted!;
}

// ---------------------------------------------------------------------------
// Manual journals (drafts editable, posted immutable)
// ---------------------------------------------------------------------------

function toLineInputs(lines: readonly { accountId: string; debit?: string; credit?: string; memo?: string | null; contactId?: string | null }[], currency: string): EntryLineInput[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    debit: l.debit ? Money.of(l.debit, currency) : undefined,
    credit: l.credit ? Money.of(l.credit, currency) : undefined,
    memo: l.memo ?? null,
    contactId: l.contactId ?? null,
  }));
}

export async function createManualJournal(s: ServiceContext, input: CreateManualJournalInput): Promise<JournalEntryDto> {
  return idempotent(s, input.idempotencyKey, input, async () => {
    const lineInputs = toLineInputs(input.lines, s.company.baseCurrency);
    if (input.post) {
      const row = await postEntry(s, {
        date: input.date,
        memo: input.memo,
        sourceType: 'manual',
        cashTreatment: input.cashTreatment,
        lines: lineInputs,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      await recordAudit(s, { action: 'journal.posted', entityType: 'journal_entry', entityId: row.id, details: { entryNumber: row.entryNumber } });
      return getEntry(s, row.id);
    }
    const lines = validateLines(s, lineInputs);
    await loadAccounts(
      s,
      lines.map((l) => l.accountId),
    );
    const [draft] = await s.tx
      .insert(schema.journalEntries)
      .values({
        companyId: s.ctx.companyId,
        date: input.date,
        memo: input.memo,
        status: 'draft',
        sourceType: 'manual',
        currency: s.company.baseCurrency,
        cashTreatment: input.cashTreatment,
        createdBy: s.ctx.actorId,
      })
      .returning();
    await insertLines(s, draft!.id, lines);
    await recordAudit(s, { action: 'journal.draft_created', entityType: 'journal_entry', entityId: draft!.id });
    return getEntry(s, draft!.id);
  });
}

export async function updateDraftJournal(s: ServiceContext, id: string, input: UpdateDraftJournalInput): Promise<JournalEntryDto> {
  const entry = await loadEntry(s, id);
  if (entry.status !== 'draft') throw new ServiceError('immutable', 'Saved journal entries can’t be edited. Reverse it and enter a corrected one.');
  if (entry.sourceType !== 'manual') throw new ServiceError('validation', 'Only manual journals can be edited');
  if (entry.version !== input.version) throw versionConflict('Journal entry');
  if (input.lines) {
    const lines = validateLines(s, toLineInputs(input.lines, s.company.baseCurrency));
    await loadAccounts(
      s,
      lines.map((l) => l.accountId),
    );
    await s.tx.delete(schema.journalLines).where(eq(schema.journalLines.entryId, id));
    await insertLines(s, id, lines);
  }
  const [row] = await s.tx
    .update(schema.journalEntries)
    .set({
      ...(input.date ? { date: input.date } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.cashTreatment ? { cashTreatment: input.cashTreatment } : {}),
    })
    .where(and(eq(schema.journalEntries.id, id), eq(schema.journalEntries.version, input.version)))
    .returning();
  if (!row) throw versionConflict('Journal entry');
  await recordAudit(s, { action: 'journal.draft_updated', entityType: 'journal_entry', entityId: id });
  return getEntry(s, id);
}

export async function deleteDraftJournal(s: ServiceContext, id: string): Promise<void> {
  const entry = await loadEntry(s, id);
  if (entry.status !== 'draft') throw new ServiceError('immutable', 'Saved journal entries can’t be deleted here. Reverse it instead.');
  await s.tx.delete(schema.journalEntries).where(eq(schema.journalEntries.id, id));
  await recordAudit(s, { action: 'journal.draft_deleted', entityType: 'journal_entry', entityId: id });
}

export async function postDraftJournal(s: ServiceContext, id: string, version: number, idempotencyKey?: string): Promise<JournalEntryDto> {
  return idempotent(s, idempotencyKey, { id, version }, async () => {
    const entry = await loadEntry(s, id);
    if (entry.status === 'posted') throw new ServiceError('invalid_state', 'Journal entry is already posted');
    if (entry.version !== version) throw versionConflict('Journal entry');
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, id)).orderBy(asc(schema.journalLines.lineNo));
    const normalized = validateLines(
      s,
      lines.map((l) => ({
        accountId: l.accountId,
        debit: Money.round(l.debit, s.company.baseCurrency),
        credit: Money.round(l.credit, s.company.baseCurrency),
      })),
    );
    const accounts = await loadAccounts(
      s,
      normalized.map((l) => l.accountId),
    );
    for (const l of normalized) {
      const a = accounts.get(l.accountId)!;
      if (a.role && PROTECTED_CONTROL_ROLES.has(a.role)) {
        throw new ServiceError('validation', `${a.name} changes only through invoices, payments and credit notes, so a journal entry can’t use it. For money tracked outside Evenbooks, use a separate account.`);
      }
    }
    await assertNotLocked(s, entry.date);
    const row = await markPosted(s, id);
    await recordAudit(s, { action: 'journal.posted', entityType: 'journal_entry', entityId: id, details: { entryNumber: row.entryNumber } });
    return getEntry(s, id);
  });
}

/**
 * Reverse a posted entry with a linked reversing entry. Never deletes. The
 * reversal inherits the original cash treatment so cash reports net to zero.
 */
export async function reverseEntry(s: ServiceContext, id: string, input: ReverseJournalInput): Promise<JournalEntryDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const original = await loadEntry(s, id, true);
    if (original.status !== 'posted') throw new ServiceError('invalid_state', 'Only posted entries can be reversed');
    if (original.reversedByEntryId) throw new ServiceError('invalid_state', 'This entry has already been reversed');
    if (original.cashTreatment === 'derived') {
      throw new ServiceError('validation', 'This entry belongs to an invoice, payment or credit note. Void or correct it from that record instead.');
    }
    if (input.date < original.date) throw new ServiceError('validation', 'A reversal cannot be dated before the original entry');
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, id)).orderBy(asc(schema.journalLines.lineNo));
    const normalized = lines.map((l) => ({
      accountId: l.accountId,
      debit: Money.round(l.debit, original.currency),
      credit: Money.round(l.credit, original.currency),
      memo: l.memo,
      contactId: l.contactId,
    }));
    const reversal = await postEntry(s, {
      date: input.date,
      memo: `Reversal of #${original.entryNumber}: ${input.reason}`,
      sourceType: 'reversal',
      sourceId: original.sourceId,
      cashTreatment: original.cashTreatment,
      lines: reverseLines(normalized),
      reversesEntryId: id,
    });
    await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, id));
    await recordAudit(s, {
      action: 'journal.reversed',
      entityType: 'journal_entry',
      entityId: id,
      reason: input.reason,
      details: { reversalEntryId: reversal.id, reversalNumber: reversal.entryNumber },
    });
    // Reconciliations that cleared lines of the original entry must be re-checked.
    await flagReconciliationsForEntry(s, id, `Entry #${original.entryNumber} was reversed`);
    return getEntry(s, reversal.id);
  });
}

export async function flagReconciliationsForEntry(s: ServiceContext, entryId: string, reason: string): Promise<void> {
  const affected = await s.tx
    .selectDistinct({ sessionId: schema.reconciliationItems.sessionId })
    .from(schema.reconciliationItems)
    .innerJoin(schema.journalLines, eq(schema.journalLines.id, schema.reconciliationItems.journalLineId))
    .where(eq(schema.journalLines.entryId, entryId));
  if (affected.length === 0) return;
  await s.tx
    .update(schema.reconciliationSessions)
    .set({ status: 'flagged', flaggedReason: reason, flaggedAt: new Date().toISOString() })
    .where(
      and(
        inArray(
          schema.reconciliationSessions.id,
          affected.map((a) => a.sessionId),
        ),
        eq(schema.reconciliationSessions.status, 'completed'),
      ),
    );
}

/**
 * Opening balances: one posted entry against Opening Balance Equity dated the
 * day before the books start. Allowed only while nothing else is posted.
 */
export async function postOpeningBalances(s: ServiceContext, input: OpeningBalancesInput): Promise<JournalEntryDto> {
  return idempotent(s, input.idempotencyKey, input, async () => {
    const cur = s.company.baseCurrency;
    const obe = await getAccountByRole(s, 'opening_balance_equity');
    const accounts = await loadAccounts(
      s,
      input.lines.map((l) => l.accountId),
    );
    const lines: EntryLineInput[] = [];
    let net = Money.zero(cur);
    for (const l of input.lines) {
      const a = accounts.get(l.accountId)!;
      if (a.role && PROTECTED_CONTROL_ROLES.has(a.role)) {
        throw new ServiceError('validation', `Opening balances for ${a.name} must be entered as Evenbooks documents (invoices/credits), not a lump sum. Receivables you will collect elsewhere belong in a separate account`);
      }
      const bal = Money.of(l.balance, cur);
      if (bal.isZero()) continue;
      const debitNormal = isDebitNormal(a.type);
      const debitSide = debitNormal ? bal.isPositive() : bal.isNegative();
      const amt = bal.abs();
      lines.push(debitSide ? { accountId: a.id, debit: amt } : { accountId: a.id, credit: amt });
      net = debitSide ? net.add(amt) : net.subtract(amt);
    }
    if (lines.length === 0) throw new ServiceError('validation', 'No non-zero opening balances supplied');
    if (!net.isZero()) lines.push(net.isPositive() ? { accountId: obe.id, credit: net } : { accountId: obe.id, debit: net.abs() });
    const row = await postEntry(s, {
      date: input.date,
      memo: 'Opening balances',
      sourceType: 'opening_balance',
      cashTreatment: 'exclude',
      lines,
    });
    await recordAudit(s, { action: 'journal.opening_balances', entityType: 'journal_entry', entityId: row.id });
    return getEntry(s, row.id);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function loadEntry(s: ServiceContext, id: string, forUpdate = false): Promise<EntryRow> {
  const q = s.tx
    .select()
    .from(schema.journalEntries)
    .where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), eq(schema.journalEntries.id, id)))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Journal entry');
  return row;
}

function toDto(e: EntryRow, lines: (LineRow & { accountCode?: string; accountName?: string })[]): JournalEntryDto {
  const cur = e.currency;
  const dtoLines: JournalLineDto[] = lines.map((l) => ({
    id: l.id,
    lineNo: l.lineNo,
    accountId: l.accountId,
    accountCode: l.accountCode,
    accountName: l.accountName,
    debit: Money.round(l.debit, cur).toString(),
    credit: Money.round(l.credit, cur).toString(),
    memo: l.memo,
    contactId: l.contactId,
  }));
  return {
    id: e.id,
    entryNumber: e.entryNumber,
    date: e.date,
    memo: e.memo,
    status: e.status,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    currency: cur,
    cashTreatment: e.cashTreatment,
    cashComponents: e.cashComponents,
    reversesEntryId: e.reversesEntryId,
    reversedByEntryId: e.reversedByEntryId,
    postedAt: e.postedAt,
    postedBy: e.postedBy,
    createdBy: e.createdBy,
    createdAt: e.createdAt,
    version: e.version,
    totalDebit: Money.sum(
      dtoLines.map((l) => Money.of(l.debit, cur)),
      cur,
    ).toString(),
    totalCredit: Money.sum(
      dtoLines.map((l) => Money.of(l.credit, cur)),
      cur,
    ).toString(),
    lines: dtoLines,
  };
}

export async function getEntry(s: ServiceContext, id: string): Promise<JournalEntryDto> {
  const entry = await loadEntry(s, id);
  const lines = await s.tx
    .select({
      id: schema.journalLines.id,
      companyId: schema.journalLines.companyId,
      entryId: schema.journalLines.entryId,
      lineNo: schema.journalLines.lineNo,
      accountId: schema.journalLines.accountId,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
      memo: schema.journalLines.memo,
      contactId: schema.journalLines.contactId,
      accountCode: schema.accounts.code,
      accountName: schema.accounts.name,
    })
    .from(schema.journalLines)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.journalLines.accountId))
    .where(eq(schema.journalLines.entryId, id))
    .orderBy(asc(schema.journalLines.lineNo));
  return toDto(entry, lines);
}

const JOURNAL_SORT_COLUMNS: SortColumns<EntryRow, (typeof JOURNAL_SORTS)[number]> = {
  date: { expr: schema.journalEntries.date, cast: 'date', value: (r) => r.date },
  // drafts have no number yet; they sort as 0
  number: { expr: sql`coalesce(${schema.journalEntries.entryNumber}, 0)`, cast: 'int', value: (r) => r.entryNumber ?? 0 },
};

export async function listEntries(s: ServiceContext, q: ListJournalQuery): Promise<Page<JournalEntryDto>> {
  const conds = [eq(schema.journalEntries.companyId, s.ctx.companyId)];
  if (q.from) conds.push(gte(schema.journalEntries.date, q.from));
  if (q.to) conds.push(lte(schema.journalEntries.date, q.to));
  if (q.status) conds.push(eq(schema.journalEntries.status, q.status));
  if (q.sourceType) conds.push(eq(schema.journalEntries.sourceType, q.sourceType as JournalSource));
  if (q.q) conds.push(ilike(schema.journalEntries.memo, `%${q.q}%`));
  if (q.accountId) {
    conds.push(
      sql`exists (select 1 from ${schema.journalLines} jl where jl.entry_id = ${schema.journalEntries.id} and jl.account_id = ${q.accountId})`,
    );
  }
  const ks = keyset({
    columns: JOURNAL_SORT_COLUMNS,
    sort: q.sort ?? 'date',
    dir: q.dir ?? 'desc',
    idColumn: schema.journalEntries.id,
    idOf: (r) => r.id,
    cursor: q.cursor,
  });
  const [{ total }] = (await s.tx.select({ total: sql<number>`count(*)::int` }).from(schema.journalEntries).where(and(...conds))) as [{ total: number }];
  const rows = await s.tx
    .select()
    .from(schema.journalEntries)
    .where(and(...conds, ks.after))
    .orderBy(...ks.orderBy)
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const ids = page.map((r) => r.id);
  const lines = ids.length
    ? await s.tx
        .select({
          id: schema.journalLines.id,
          companyId: schema.journalLines.companyId,
          entryId: schema.journalLines.entryId,
          lineNo: schema.journalLines.lineNo,
          accountId: schema.journalLines.accountId,
          debit: schema.journalLines.debit,
          credit: schema.journalLines.credit,
          memo: schema.journalLines.memo,
          contactId: schema.journalLines.contactId,
          accountCode: schema.accounts.code,
          accountName: schema.accounts.name,
        })
        .from(schema.journalLines)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.journalLines.accountId))
        .where(inArray(schema.journalLines.entryId, ids))
        .orderBy(asc(schema.journalLines.lineNo))
    : [];
  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) {
    if (!byEntry.has(l.entryId)) byEntry.set(l.entryId, []);
    byEntry.get(l.entryId)!.push(l);
  }
  const items = page.map((e) => toDto(e, byEntry.get(e.id) ?? []));
  return { items, nextCursor: ks.next(rows, q.limit), total };
}
