import { and, asc, desc, eq, gte, ilike, inArray, lte, lt, ne, or, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money, addDays, todayInTimeZone, type EntryLineInput } from '@evenbooks/domain';
import { isTransferAccount } from '@evenbooks/contracts';
import type {
  BankTransactionDto,
  CategorizeInput,
  ExcludeInput,
  ListInboxQuery,
  InboxPageDto,
  BulkReviewInput,
  BulkReviewItemResult,
  BulkReviewResultDto,
  MatchCandidateDto,
  MatchInput,
  TransferInput,
  UndoReviewInput,
  CreateManualBankTransactionInput,
  InvoiceCandidateDto,
  InvoiceCandidatesQuery,
  RecordInvoicePaymentInput,
} from '@evenbooks/contracts';
import type { z } from 'zod';
import { ServiceError, notFound, plainMoney, translateDbError, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { postEntry, flagReconciliationsForEntry } from './ledger';
import { getBankAccount } from './bank-accounts';
import { getAccount, getAccountByRole } from './accounts';
import { createPurchase, voidPurchase } from './purchases';
import { createPayment } from './payments';
import { attachTo } from './attachments';
import { suggestRules, bumpRuleHit, createRule } from './rules';

type TxnRow = typeof schema.bankTransactions.$inferSelect;

function toDto(t: TxnRow, bankAccountName?: string, suggestion?: BankTransactionDto['suggestion'], matchHint?: BankTransactionDto['matchHint']): BankTransactionDto {
  return {
    id: t.id,
    bankAccountId: t.bankAccountId,
    bankAccountName,
    source: t.source,
    date: t.date,
    amount: Money.round(t.amount, t.currency).toString(),
    currency: t.currency,
    description: t.description,
    payee: t.payee,
    memo: t.memo,
    reference: t.reference,
    pending: t.pending,
    status: t.status,
    excludedReason: t.excludedReason,
    journalEntryId: t.journalEntryId,
    changedAt: t.changedAt,
    changeNote: t.changeNote,
    reviewedBy: t.reviewedBy,
    reviewedAt: t.reviewedAt,
    version: t.version,
    suggestion: suggestion ?? null,
    matchHint: matchHint ?? null,
  };
}

async function loadTxn(s: ServiceContext, id: string): Promise<TxnRow> {
  const [row] = await s.tx
    .select()
    .from(schema.bankTransactions)
    .where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), eq(schema.bankTransactions.id, id)))
    .limit(1);
  if (!row) throw notFound('Bank transaction');
  return row;
}

async function withSuggestions(s: ServiceContext, rows: TxnRow[], hints?: Map<string, NonNullable<BankTransactionDto['matchHint']>>): Promise<BankTransactionDto[]> {
  const accounts = await s.tx.select({ id: schema.bankAccounts.id, name: schema.bankAccounts.name }).from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, s.ctx.companyId));
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));
  const unreviewed = rows.filter((r) => r.status === 'unreviewed');
  const suggestions = await suggestRules(s, unreviewed);
  const accountIds = [...new Set([...suggestions.values()].map((r) => r.accountId))];
  const accts = accountIds.length ? await s.tx.select({ id: schema.accounts.id, name: schema.accounts.name }).from(schema.accounts).where(inArray(schema.accounts.id, accountIds)) : [];
  const acctName = new Map(accts.map((a) => [a.id, a.name]));
  return rows.map((r) => {
    const rule = suggestions.get(r.id);
    return toDto(
      r,
      nameById.get(r.bankAccountId),
      rule ? { ruleId: rule.id, ruleName: rule.name, accountId: rule.accountId, accountName: acctName.get(rule.accountId) ?? '', contactId: rule.contactId, memo: rule.memo } : null,
      hints?.get(r.id) ?? null,
    );
  });
}

/** "45", "$1,200.50", "-4.5" → "1200.50"-style absolute amount, or null when the search is not a number. */
export function amountFromSearch(q: string): string | null {
  const t = q.trim().replace(/[$\s,]/g, '').replace(/^[-+]/, '');
  return /^(\d+(\.\d{1,6})?|\.\d{1,6})$/.test(t) ? (t.startsWith('.') ? `0${t}` : t) : null;
}

/** Filters shared by the page query and the tab counts: everything except status and paging. */
function inboxFilterConds(s: ServiceContext, q: ListInboxQuery) {
  const bt = schema.bankTransactions;
  const conds = [eq(bt.companyId, s.ctx.companyId)];
  if (q.bankAccountId) conds.push(eq(bt.bankAccountId, q.bankAccountId));
  if (q.from) conds.push(gte(bt.date, q.from));
  if (q.to) conds.push(lte(bt.date, q.to));
  const text = q.q?.trim();
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const amount = amountFromSearch(text);
    conds.push(or(ilike(bt.description, like), ilike(bt.payee, like), ilike(bt.memo, like), ...(amount ? [sql`abs(${bt.amount}) = ${amount}::numeric`] : []))!);
  }
  if (q.amountMin) conds.push(sql`abs(${bt.amount}) >= ${q.amountMin}::numeric`);
  if (q.amountMax) conds.push(sql`abs(${bt.amount}) <= ${q.amountMax}::numeric`);
  return conds;
}

/** Postgres array literal for server-generated values (uuids, dates, decimals); never user text. */
const pgArray = (values: string[]) => `{${values.join(',')}}`;

/** How far before a deposit a payment waiting in Undeposited Funds may have been received, and after. */
const UNDEPOSITED_DAYS_BEFORE = 60;
const UNDEPOSITED_DAYS_AFTER = 3;

/**
 * Match hints for a page of unreviewed rows in one round trip: ledger lines on
 * each row's bank ledger account with the same signed amount within ±7 days that
 * are not yet tied to a bank line, plus customer payments of the same amount
 * still in Undeposited Funds (count); opposite-amount unreviewed lines in other
 * bank accounts within ±5 days (transfers); and, for money into a bank account,
 * open invoices whose balance is exactly the amount (invoices). Mirrors
 * `matchCandidates` and `invoiceCandidates`, cheaply.
 */
async function matchHints(s: ServiceContext, rows: TxnRow[]): Promise<Map<string, NonNullable<BankTransactionDto['matchHint']>>> {
  const out = new Map<string, NonNullable<BankTransactionDto['matchHint']>>();
  const todo = rows.filter((r) => r.status === 'unreviewed');
  if (todo.length === 0) return out;
  const c = s.ctx.companyId;
  const undepositedId = (await getAccountByRole(s, 'undeposited_funds').catch(() => null))?.id ?? null;
  const res = await s.tx.execute<{ id: string; n: number; best_days: number | null; undeposited: number; transfers: number; invoices: number }>(sql`
    with p as (
      select u.id, u.d, u.amt, u.ba_id, ba.ledger_account_id as ledger_id, ba.kind
      from unnest(${pgArray(todo.map((r) => r.id))}::uuid[], ${pgArray(todo.map((r) => r.date))}::date[], ${pgArray(todo.map((r) => r.amount))}::numeric[], ${pgArray(todo.map((r) => r.bankAccountId))}::uuid[]) as u(id, d, amt, ba_id)
      join bank_accounts ba on ba.company_id = ${c} and ba.id = u.ba_id
    ),
    cand as (
      select jl.account_id, je.id as entry_id, je.date, je.source_type::text as source_type, je.source_id, (jl.debit - jl.credit) as eff
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id
      where jl.company_id = ${c}
        and jl.account_id in (select ledger_id from p)
        and je.status = 'posted'
        and je.date between (select min(d) from p) - 7 and (select max(d) from p) + 7
        and not exists (select 1 from bank_transactions b where b.company_id = ${c} and b.journal_entry_id = je.id)
        and not exists (
          select 1 from transaction_matches tm
          where tm.company_id = ${c}
            and ((tm.target_type = 'journal_entry' and tm.target_id = je.id)
              or (je.source_id is not null and tm.target_type = je.source_type::text and tm.target_id = je.source_id))
        )
    ),
    undep as (
      select py.amount, py.date
      from payments py
      where py.company_id = ${c}
        and py.status = 'posted'
        and py.deposit_account_id = ${undepositedId}::uuid
        and py.date between (select min(d) from p) - ${UNDEPOSITED_DAYS_BEFORE}::int and (select max(d) from p) + ${UNDEPOSITED_DAYS_AFTER}::int
        and not exists (select 1 from transaction_matches tm where tm.company_id = ${c} and tm.target_type = 'payment' and tm.target_id = py.id)
    )
    select p.id::text as id,
      (select count(*)::int from cand where cand.account_id = p.ledger_id and cand.eff = p.amt and cand.date between p.d - 7 and p.d + 7) as n,
      (select min(abs(cand.date - p.d))::int from cand where cand.account_id = p.ledger_id and cand.eff = p.amt and cand.date between p.d - 7 and p.d + 7) as best_days,
      (select count(*)::int from undep where p.amt > 0 and undep.amount = p.amt
        and undep.date between p.d - ${UNDEPOSITED_DAYS_BEFORE}::int and p.d + ${UNDEPOSITED_DAYS_AFTER}::int) as undeposited,
      (select count(*)::int from bank_transactions o
        where o.company_id = ${c} and o.status = 'unreviewed' and o.bank_account_id <> p.ba_id
          and o.amount = -p.amt and o.date between p.d - 5 and p.d + 5) as transfers,
      (select count(*)::int from invoices i
        where i.company_id = ${c} and p.kind = 'bank' and p.amt > 0 and i.status = 'issued'
          and i.balance_due = p.amt and i.issue_date <= p.d + 7) as invoices
    from p
  `);
  for (const r of res.rows) {
    const n = Number(r.n);
    const undeposited = Number(r.undeposited);
    const transfers = Number(r.transfers);
    const invoices = Number(r.invoices);
    if (n + undeposited > 0 || transfers > 0 || invoices > 0) {
      // A waiting payment of exactly this amount is as strong a sign as a same-day ledger record.
      const topScore = Math.max(r.best_days === null ? 0 : 100 - Number(r.best_days) * 5, undeposited > 0 ? 90 : 0);
      out.set(r.id, { count: n + undeposited, topScore, transfers, invoices });
    }
  }
  return out;
}

/** Most unreviewed rows scanned to count rule suggestions; beyond this the count is a lower bound. */
const SUGGESTION_SCAN_LIMIT = 5000;

export async function listInbox(s: ServiceContext, q: ListInboxQuery): Promise<InboxPageDto> {
  const bt = schema.bankTransactions;
  const filters = inboxFilterConds(s, q);
  const conds = [...filters];
  if (q.status) conds.push(eq(bt.status, q.status));
  if (q.cursor) {
    const [d, id] = q.cursor.split('|');
    if (d && id) conds.push(or(lt(bt.date, d), and(eq(bt.date, d), lt(bt.id, id)))!);
  }
  const rows = await s.tx
    .select()
    .from(bt)
    .where(and(...conds))
    .orderBy(desc(bt.date), desc(bt.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const countRows = await s.tx
    .select({ status: bt.status, n: sql<number>`count(*)::int` })
    .from(bt)
    .where(and(...filters))
    .groupBy(bt.status);
  const counts: Record<string, number> = {};
  for (const c of countRows) counts[c.status] = Number(c.n);
  let suggestedCount = 0;
  if ((counts.unreviewed ?? 0) > 0) {
    const open = await s.tx
      .select({ id: bt.id, description: bt.description, payee: bt.payee, amount: bt.amount, bankAccountId: bt.bankAccountId })
      .from(bt)
      .where(and(...filters, eq(bt.status, 'unreviewed')))
      .limit(SUGGESTION_SCAN_LIMIT);
    suggestedCount = (await suggestRules(s, open)).size;
  }
  const hints = await matchHints(s, page);
  return { items: await withSuggestions(s, page, hints), nextCursor: rows.length > q.limit && last ? `${last.date}|${last.id}` : null, counts, suggestedCount };
}

export async function getBankTransaction(s: ServiceContext, id: string): Promise<BankTransactionDto> {
  const row = await loadTxn(s, id);
  return (await withSuggestions(s, [row], await matchHints(s, [row])))[0]!;
}

export async function createManualBankTransaction(s: ServiceContext, input: z.infer<typeof CreateManualBankTransactionInput>): Promise<BankTransactionDto> {
  const ba = await getBankAccount(s, input.bankAccountId);
  const amount = Money.of(input.amount, ba.currency);
  if (amount.isZero()) throw new ServiceError('validation', 'Amount cannot be zero');
  const fp = `manual:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const [row] = await s.tx
    .insert(schema.bankTransactions)
    .values({
      companyId: s.ctx.companyId,
      bankAccountId: ba.id,
      source: 'manual',
      fingerprint: fp,
      date: input.date,
      amount: amount.toString(),
      currency: ba.currency,
      description: input.description,
      memo: input.memo ?? null,
    })
    .returning();
  return toDto(row!, ba.name);
}

type CandidateDraft = Omit<MatchCandidateDto, 'description' | 'detail'> & { entryId: string; entryNumber: number | null; memo: string; sourceType: string };

/**
 * Plain labels for match candidates: "Payment from Acme · INV-1004",
 * "Expense · Staples", "Transfer from Savings", never an entry number alone.
 */
async function describeCandidates(s: ServiceContext, drafts: CandidateDraft[], bankLedgerId: string): Promise<MatchCandidateDto[]> {
  const c = s.ctx.companyId;
  const idsOf = (type: MatchCandidateDto['targetType']) => drafts.filter((d) => d.targetType === type).map((d) => d.targetId);
  const paymentIds = idsOf('payment');
  const purchaseIds = idsOf('purchase');
  const refundIds = idsOf('refund');
  const entryIds = drafts.filter((d) => d.targetType === 'journal_entry').map((d) => d.entryId);
  const contactOf = new Map<string, string | null>();
  const referenceOf = new Map<string, string | null>();
  if (paymentIds.length) {
    for (const p of await s.tx.select({ id: schema.payments.id, contactId: schema.payments.contactId, reference: schema.payments.reference }).from(schema.payments).where(and(eq(schema.payments.companyId, c), inArray(schema.payments.id, paymentIds)))) {
      contactOf.set(p.id, p.contactId);
      referenceOf.set(p.id, p.reference);
    }
  }
  if (purchaseIds.length) {
    for (const p of await s.tx.select({ id: schema.purchases.id, contactId: schema.purchases.contactId, reference: schema.purchases.reference }).from(schema.purchases).where(and(eq(schema.purchases.companyId, c), inArray(schema.purchases.id, purchaseIds)))) {
      contactOf.set(p.id, p.contactId);
      referenceOf.set(p.id, p.reference);
    }
  }
  if (refundIds.length) {
    for (const r of await s.tx.select({ id: schema.refunds.id, contactId: schema.refunds.contactId }).from(schema.refunds).where(and(eq(schema.refunds.companyId, c), inArray(schema.refunds.id, refundIds)))) contactOf.set(r.id, r.contactId);
  }
  const contactIds = [...new Set([...contactOf.values()].filter((x): x is string => Boolean(x)))];
  const contactName = new Map(
    (contactIds.length ? await s.tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts).where(inArray(schema.contacts.id, contactIds)) : []).map((x) => [x.id, x.name]),
  );
  const invoicesOf = new Map<string, string[]>();
  if (paymentIds.length) {
    const allocs = await s.tx
      .select({ paymentId: schema.paymentAllocations.paymentId, number: schema.invoices.number })
      .from(schema.paymentAllocations)
      .innerJoin(schema.invoices, eq(schema.invoices.id, schema.paymentAllocations.invoiceId))
      .where(and(eq(schema.paymentAllocations.companyId, c), inArray(schema.paymentAllocations.paymentId, paymentIds), eq(schema.paymentAllocations.status, 'active')));
    for (const a of allocs) if (a.paymentId && a.number) invoicesOf.set(a.paymentId, [...(invoicesOf.get(a.paymentId) ?? []), a.number]);
  }
  // The other side of a manual entry or transfer: "Transfer from Savings".
  const otherAccountOf = new Map<string, string>();
  if (entryIds.length) {
    const others = await s.tx
      .select({ entryId: schema.journalLines.entryId, name: schema.accounts.name })
      .from(schema.journalLines)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.journalLines.accountId))
      .where(and(eq(schema.journalLines.companyId, c), inArray(schema.journalLines.entryId, entryIds), ne(schema.journalLines.accountId, bankLedgerId)))
      .orderBy(asc(schema.journalLines.lineNo));
    for (const o of others) if (!otherAccountOf.has(o.entryId)) otherAccountOf.set(o.entryId, o.name);
  }
  const join = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
  return drafts.map(({ entryId, entryNumber, memo, sourceType, ...d }) => {
    const moneyIn = !d.amount.startsWith('-');
    const who = contactOf.get(d.targetId) ? contactName.get(contactOf.get(d.targetId)!) : null;
    let description: string;
    let detail: string | null;
    if (d.targetType === 'payment') {
      description = join(who ? `Payment from ${who}` : 'Customer payment', (invoicesOf.get(d.targetId) ?? []).join(', '));
      detail = join(d.undeposited ? 'Waiting to be deposited' : null, referenceOf.get(d.targetId) ? `Ref ${referenceOf.get(d.targetId)}` : null, memo && !memo.startsWith('Payment') ? memo : null) || null;
    } else if (d.targetType === 'purchase') {
      description = join('Expense', who ?? memo);
      detail = join(who ? memo : null, referenceOf.get(d.targetId) ? `Ref ${referenceOf.get(d.targetId)}` : null) || null;
    } else if (d.targetType === 'refund') {
      description = who ? `Refund to ${who}` : 'Refund to a customer';
      detail = memo || null;
    } else if (d.targetType === 'processor_payout') {
      description = 'Stripe payout';
      detail = 'Online card payments paid out to this account';
    } else {
      const other = otherAccountOf.get(entryId);
      if (sourceType === 'transfer' && other) description = `Transfer ${moneyIn ? 'from' : 'to'} ${other}`;
      else if (other) description = `${moneyIn ? 'Money in from' : 'Money out to'} ${other}`;
      else description = memo || 'Journal entry';
      detail = join(description === memo ? null : memo, entryNumber !== null ? `Journal entry #${entryNumber}` : null) || null;
    }
    return { ...d, description, detail };
  });
}

/**
 * Match candidates for a bank transaction:
 *  - ledger events on the same bank ledger account with the same signed amount within ±7 days
 *    (payments, purchases, refunds, other entries) that are not already matched
 *  - for money in, customer payments still in Undeposited Funds (received up to 60 days
 *    before), any amount up to the deposit, since several often make up one deposit
 *  - counterpart bank transactions in other accounts with the opposite amount within ±5 days (transfers)
 */
export async function matchCandidates(s: ServiceContext, id: string): Promise<MatchCandidateDto[]> {
  const t = await loadTxn(s, id);
  const ba = await getBankAccount(s, t.bankAccountId);
  const amt = Money.round(t.amount, t.currency);
  const from = addDays(t.date, -7);
  const to = addDays(t.date, 7);
  const drafts: CandidateDraft[] = [];
  const dayDiff = (d: string) => Math.abs((Date.parse(d) - Date.parse(t.date)) / 86_400_000);

  // Feed sign convention: positive = money into the account. For both a bank asset and a
  // card liability a ledger debit shows as positive in the feed (deposit / card payment)
  // and a credit as negative (withdrawal / card charge), so effect = debit - credit.
  const lines = await s.tx
    .select({
      lineId: schema.journalLines.id,
      entryId: schema.journalEntries.id,
      entryNumber: schema.journalEntries.entryNumber,
      date: schema.journalEntries.date,
      memo: schema.journalEntries.memo,
      sourceType: schema.journalEntries.sourceType,
      sourceId: schema.journalEntries.sourceId,
      debit: schema.journalLines.debit,
      credit: schema.journalLines.credit,
    })
    .from(schema.journalLines)
    .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(
      and(
        eq(schema.journalLines.companyId, s.ctx.companyId),
        eq(schema.journalLines.accountId, ba.ledgerAccountId),
        eq(schema.journalEntries.status, 'posted'),
        gte(schema.journalEntries.date, from),
        lte(schema.journalEntries.date, to),
      ),
    );
  const matched = await s.tx
    .select({ targetType: schema.transactionMatches.targetType, targetId: schema.transactionMatches.targetId })
    .from(schema.transactionMatches)
    .where(eq(schema.transactionMatches.companyId, s.ctx.companyId));
  const matchedKeys = new Set(matched.map((m) => `${m.targetType}:${m.targetId}`));
  const linkedEntries = new Set(
    (await s.tx.select({ id: schema.bankTransactions.journalEntryId }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), sql`${schema.bankTransactions.journalEntryId} is not null`))).map((r) => r.id),
  );
  for (const l of lines) {
    const effect = Money.round(l.debit, t.currency).subtract(Money.round(l.credit, t.currency));
    if (!effect.equals(amt)) continue;
    if (linkedEntries.has(l.entryId)) continue;
    let targetType: MatchCandidateDto['targetType'] = 'journal_entry';
    let targetId = l.entryId;
    if (l.sourceType === 'payment' && l.sourceId) {
      targetType = 'payment';
      targetId = l.sourceId;
    } else if (l.sourceType === 'purchase' && l.sourceId) {
      targetType = 'purchase';
      targetId = l.sourceId;
    } else if (l.sourceType === 'refund' && l.sourceId) {
      targetType = 'refund';
      targetId = l.sourceId;
    } else if (l.sourceType === 'processor_payout' && l.sourceId) {
      targetType = 'processor_payout';
      targetId = l.sourceId;
    }
    if (matchedKeys.has(`${targetType}:${targetId}`)) continue;
    drafts.push({ targetType, targetId, date: l.date, amount: effect.toString(), score: 100 - dayDiff(l.date) * 5, entryId: l.entryId, entryNumber: l.entryNumber, memo: l.memo ?? '', sourceType: l.sourceType });
  }

  // Customer payments waiting in Undeposited Funds, for a deposit into a bank account.
  const undeposited = amt.isPositive() && ba.kind === 'bank' ? await getAccountByRole(s, 'undeposited_funds').catch(() => null) : null;
  if (undeposited) {
    const waiting = await s.tx
      .select()
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.companyId, s.ctx.companyId),
          eq(schema.payments.status, 'posted'),
          eq(schema.payments.depositAccountId, undeposited.id),
          eq(schema.payments.currency, t.currency),
          gte(schema.payments.date, addDays(t.date, -UNDEPOSITED_DAYS_BEFORE)),
          lte(schema.payments.date, addDays(t.date, UNDEPOSITED_DAYS_AFTER)),
          lte(schema.payments.amount, amt.toString()),
        ),
      );
    for (const p of waiting) {
      if (matchedKeys.has(`payment:${p.id}`)) continue;
      const amount = Money.round(p.amount, t.currency);
      // An exact amount ranks with same-week records; parts of a larger deposit rank below.
      const score = amount.equals(amt) ? 95 - Math.min(dayDiff(p.date), 10) : 60 - Math.min(dayDiff(p.date), 30);
      drafts.push({ targetType: 'payment', targetId: p.id, date: p.date, amount: amount.toString(), undeposited: true, score, entryId: p.journalEntryId, entryNumber: null, memo: p.memo ?? '', sourceType: 'payment' });
    }
  }
  const out = await describeCandidates(s, drafts, ba.ledgerAccountId);

  // Transfer counterparts
  const counterparts = await s.tx
    .select({ t: schema.bankTransactions, name: schema.bankAccounts.name })
    .from(schema.bankTransactions)
    .innerJoin(schema.bankAccounts, eq(schema.bankAccounts.id, schema.bankTransactions.bankAccountId))
    .where(
      and(
        eq(schema.bankTransactions.companyId, s.ctx.companyId),
        ne(schema.bankTransactions.bankAccountId, t.bankAccountId),
        eq(schema.bankTransactions.status, 'unreviewed'),
        eq(schema.bankTransactions.amount, amt.negate().toString()),
        gte(schema.bankTransactions.date, addDays(t.date, -5)),
        lte(schema.bankTransactions.date, addDays(t.date, 5)),
      ),
    );
  for (const c of counterparts) {
    out.push({
      targetType: 'bank_transaction',
      targetId: c.t.id,
      date: c.t.date,
      amount: Money.round(c.t.amount, c.t.currency).toString(),
      description: c.t.description,
      detail: `${amt.isPositive() ? 'Money left' : 'Money arrived in'} ${c.name} around the same day`,
      bankAccountName: c.name,
      score: 90 - dayDiff(c.t.date) * 5,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Customer name words worth looking for in a bank description ("ACME" in "DEPOSIT ACME CORP 0412"). */
const NAME_NOISE = new Set(['llc', 'inc', 'corp', 'co', 'ltd', 'the', 'and', 'company', 'group', 'services', 'service', 'pllc', 'llp']);
function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !NAME_NOISE.has(w));
}

/**
 * Unpaid invoices a deposit could be paying: those whose balance equals the
 * amount, every open invoice of the chosen customer (or of a customer whose
 * name appears in the bank description or payee), and other balances within
 * 10% of the amount. Only for money in; best first.
 */
export async function invoiceCandidates(s: ServiceContext, id: string, q: InvoiceCandidatesQuery): Promise<InvoiceCandidateDto[]> {
  const t = await loadTxn(s, id);
  const amt = Money.round(t.amount, t.currency);
  if (!amt.isPositive()) return [];
  const rows = await s.tx
    .select({ i: schema.invoices, contactName: schema.contacts.name })
    .from(schema.invoices)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.invoices.contactId))
    .where(
      and(
        eq(schema.invoices.companyId, s.ctx.companyId),
        eq(schema.invoices.status, 'issued'),
        eq(schema.invoices.currency, t.currency),
        sql`${schema.invoices.balanceDue} > 0`,
        q.contactId ? eq(schema.invoices.contactId, q.contactId) : undefined,
      ),
    )
    .orderBy(asc(schema.invoices.dueDate), asc(schema.invoices.issueDate))
    .limit(2000);
  const words = new Set(nameWords(`${t.description} ${t.payee ?? ''}`));
  const recognized = (name: string) => {
    const w = nameWords(name);
    return w.length > 0 && w.some((x) => words.has(x));
  };
  const today = todayInTimeZone(s.company.timeZone);
  const tolerance = amt.multiply('0.1');
  const out: InvoiceCandidateDto[] = [];
  for (const { i, contactName } of rows) {
    const balance = Money.round(i.balanceDue, i.currency);
    const exact = balance.equals(amt);
    const customer = Boolean(q.contactId) || recognized(contactName);
    const close = balance.subtract(amt).abs().lte(tolerance);
    if (!exact && !customer && !close) continue;
    const days = Math.min(Math.abs((Date.parse(i.issueDate) - Date.parse(t.date)) / 86_400_000), 60);
    const score = (exact ? 100 : 0) + (customer ? 50 : 0) + (close && !exact ? 20 : 0) - days / 6;
    out.push({
      invoiceId: i.id,
      number: i.number ?? '',
      contactId: i.contactId,
      contactName,
      issueDate: i.issueDate,
      dueDate: i.dueDate,
      total: Money.round(i.total, i.currency).toString(),
      balanceDue: balance.toString(),
      isOverdue: i.dueDate < today,
      reason: exact ? 'exact' : customer ? 'customer' : 'close',
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 25);
}

function assertUnreviewed(t: TxnRow, version: number): void {
  if (t.version !== version) throw versionConflict('Bank transaction');
  if (t.status !== 'unreviewed') throw new ServiceError('invalid_state', 'This bank transaction was already reviewed. Reload to see what it was recorded as.');
}

async function markReviewed(s: ServiceContext, id: string, version: number, patch: Partial<TxnRow>): Promise<TxnRow> {
  const [row] = await s.tx
    .update(schema.bankTransactions)
    .set({ ...patch, reviewedAt: new Date().toISOString(), reviewedBy: s.ctx.actorId })
    .where(and(eq(schema.bankTransactions.id, id), eq(schema.bankTransactions.version, version)))
    .returning();
  if (!row) throw versionConflict('Bank transaction');
  return row;
}

/**
 * Categorize (optionally split): money out becomes a paid purchase; money in
 * (not an invoice payment) posts Dr bank / Cr income lines as a cash event.
 * Money out to owner equity only (personal spending, an owner draw) posts
 * Dr equity / Cr bank directly: it is not an expense, so no purchase is made.
 * Uploaded receipts link to the purchase, or else to the posted entry.
 */
export async function categorizeTransaction(s: ServiceContext, id: string, input: CategorizeInput): Promise<BankTransactionDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const t = await loadTxn(s, id);
    assertUnreviewed(t, input.version);
    const ba = await getBankAccount(s, t.bankAccountId);
    const cur = t.currency;
    const amt = Money.round(t.amount, cur);
    const lineTotal = Money.sum(input.lines.map((l) => Money.of(l.amount, cur)), cur);
    if (!lineTotal.equals(amt.abs())) {
      throw new ServiceError('validation', `The split lines (${plainMoney(lineTotal, cur)}) must add up to the transaction amount (${plainMoney(amt.abs(), cur)}).`);
    }
    const lineAccounts = await Promise.all(input.lines.map((l) => getAccount(s, l.accountId)));
    const attachmentIds = input.attachmentIds ?? [];
    let entryId: string;
    if (amt.isNegative() && lineAccounts.every((a) => a.type === 'equity')) {
      // money out to the owner → owner draw entry, not a purchase
      const entry = await postEntry(s, {
        date: t.date,
        memo: input.memo ?? t.description,
        sourceType: 'bank_categorization',
        sourceId: t.id,
        cashTreatment: 'include',
        lines: [
          ...input.lines.map((l) => ({ accountId: l.accountId, debit: Money.of(l.amount, cur), memo: l.description || null, contactId: input.contactId ?? null })),
          { accountId: ba.ledgerAccountId, credit: amt.abs(), memo: input.memo ?? t.description, contactId: input.contactId ?? null },
        ],
      });
      entryId = entry.id;
      await s.tx.insert(schema.transactionMatches).values({ companyId: s.ctx.companyId, bankTransactionId: t.id, targetType: 'journal_entry', targetId: entry.id, amount: amt.toString(), createdBy: s.ctx.actorId });
      await attachTo(s, attachmentIds, 'journal_entry', entry.id);
    } else if (amt.isNegative()) {
      // money out → purchase
      const purchase = await createPurchase(s, {
        date: t.date,
        contactId: input.contactId ?? null,
        paidFromAccountId: ba.ledgerAccountId,
        direction: 'outflow',
        reference: t.reference ?? null,
        memo: input.memo ?? t.description,
        lines: input.lines.map((l) => ({ accountId: l.accountId, description: l.description || t.description, amount: l.amount })),
        attachmentIds,
        bankTransactionId: t.id,
      });
      entryId = purchase.journalEntryId;
      await s.tx.insert(schema.transactionMatches).values({ companyId: s.ctx.companyId, bankTransactionId: t.id, targetType: 'purchase', targetId: purchase.id, amount: amt.toString(), createdBy: s.ctx.actorId });
    } else {
      // money in → income (or vendor refund if the account is an expense account)
      for (const a of lineAccounts) {
        if (a.role === 'accounts_receivable' || a.role === 'customer_deposits') {
          throw new ServiceError('validation', 'To record a customer paying an invoice, use Match and choose the invoice, so the invoice shows as paid.');
        }
      }
      const lines: EntryLineInput[] = [
        { accountId: ba.ledgerAccountId, debit: amt.abs(), memo: input.memo ?? t.description, contactId: input.contactId ?? null },
        ...input.lines.map((l) => ({ accountId: l.accountId, credit: Money.of(l.amount, cur), memo: l.description || null, contactId: input.contactId ?? null })),
      ];
      const entry = await postEntry(s, {
        date: t.date,
        memo: input.memo ?? t.description,
        sourceType: 'bank_categorization',
        sourceId: t.id,
        cashTreatment: 'include',
        lines,
      });
      entryId = entry.id;
      await s.tx.insert(schema.transactionMatches).values({ companyId: s.ctx.companyId, bankTransactionId: t.id, targetType: 'journal_entry', targetId: entry.id, amount: amt.toString(), createdBy: s.ctx.actorId });
      await attachTo(s, attachmentIds, 'journal_entry', entry.id);
    }
    if (input.createRule && input.lines.length === 1) {
      await createRule(s, {
        name: `Auto: ${input.createRule.pattern}`,
        priority: 100,
        direction: input.createRule.direction ?? (amt.isNegative() ? 'out' : 'in'),
        matchField: 'description',
        matchType: input.createRule.matchType,
        pattern: input.createRule.pattern,
        accountId: input.lines[0]!.accountId,
        contactId: input.contactId ?? null,
        memo: null,
      });
    }
    const suggestion = (await suggestRules(s, [t])).get(t.id);
    if (suggestion && input.lines.length === 1 && suggestion.accountId === input.lines[0]!.accountId) await bumpRuleHit(s, suggestion.id);
    const row = await markReviewed(s, id, input.version, { status: 'categorized', journalEntryId: entryId });
    await recordAudit(s, { action: 'bank_transaction.categorized', entityType: 'bank_transaction', entityId: id, details: { entryId, lines: input.lines.length } });
    return toDto(row, ba.name);
  });
}

/**
 * Transfer between two of the company's own accounts. Posts one entry and marks
 * both bank transactions (when both are imported) so neither is posted twice.
 */
export async function transferTransaction(s: ServiceContext, id: string, input: TransferInput): Promise<BankTransactionDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const t = await loadTxn(s, id);
    assertUnreviewed(t, input.version);
    const ba = await getBankAccount(s, t.bankAccountId);
    const cur = t.currency;
    const amt = Money.round(t.amount, cur);
    let otherLedgerId: string;
    let counterpart: TxnRow | null = null;
    if (input.counterpartTransactionId) {
      counterpart = await loadTxn(s, input.counterpartTransactionId);
      if (counterpart.status !== 'unreviewed') throw new ServiceError('invalid_state', 'The other side was already reviewed. Reload and choose again.');
      if (counterpart.bankAccountId === t.bankAccountId) throw new ServiceError('validation', 'Pick the other account the money moved to or from, not this one.');
      if (!Money.round(counterpart.amount, cur).equals(amt.negate())) throw new ServiceError('validation', 'The other side must be the same amount, going the other way.');
      otherLedgerId = (await getBankAccount(s, counterpart.bankAccountId)).ledgerAccountId;
    } else {
      const other = await getAccount(s, input.otherLedgerAccountId!);
      if (!isTransferAccount(other)) {
        throw new ServiceError('validation', 'A transfer moves money between your own accounts (bank, card, loan or owner). For income or spending, use Categorize.');
      }
      if (other.id === ba.ledgerAccountId) throw new ServiceError('validation', 'Choose a different account');
      otherLedgerId = other.id;
    }
    // Money in to this account: Dr this ledger, Cr other. Money out: Dr other, Cr this.
    const lines: EntryLineInput[] = amt.isPositive()
      ? [
          { accountId: ba.ledgerAccountId, debit: amt },
          { accountId: otherLedgerId, credit: amt },
        ]
      : [
          { accountId: otherLedgerId, debit: amt.abs() },
          { accountId: ba.ledgerAccountId, credit: amt.abs() },
        ];
    const entry = await postEntry(s, {
      date: t.date,
      memo: input.memo ?? `Transfer: ${t.description}`,
      sourceType: 'transfer',
      sourceId: t.id,
      cashTreatment: 'exclude',
      lines,
    });
    await s.tx.insert(schema.transactionMatches).values({ companyId: s.ctx.companyId, bankTransactionId: t.id, targetType: 'journal_entry', targetId: entry.id, amount: amt.toString(), createdBy: s.ctx.actorId });
    const row = await markReviewed(s, id, input.version, { status: 'transfer', journalEntryId: entry.id });
    if (counterpart) {
      await s.tx.insert(schema.transactionMatches).values([
        { companyId: s.ctx.companyId, bankTransactionId: counterpart.id, targetType: 'journal_entry', targetId: entry.id, amount: counterpart.amount, createdBy: s.ctx.actorId },
        { companyId: s.ctx.companyId, bankTransactionId: t.id, targetType: 'bank_transaction', targetId: counterpart.id, amount: amt.toString(), createdBy: s.ctx.actorId },
      ]);
      await markReviewed(s, counterpart.id, counterpart.version, { status: 'transfer', journalEntryId: entry.id });
    }
    await recordAudit(s, { action: 'bank_transaction.transfer', entityType: 'bank_transaction', entityId: id, details: { entryId: entry.id, counterpartId: counterpart?.id ?? null } });
    return toDto(row, ba.name);
  });
}

/**
 * Match to existing ledger events (payments, purchases, refunds, entries). No new
 * posting unless a fee explains a smaller net deposit, or the targets were
 * recorded to Undeposited Funds (then a deposit entry moves them to the bank).
 */
export async function matchTransaction(s: ServiceContext, id: string, input: MatchInput): Promise<BankTransactionDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const t = await loadTxn(s, id);
    assertUnreviewed(t, input.version);
    const ba = await getBankAccount(s, t.bankAccountId);
    const cur = t.currency;
    const amt = Money.round(t.amount, cur);
    const existing = await s.tx
      .select({ targetType: schema.transactionMatches.targetType, targetId: schema.transactionMatches.targetId })
      .from(schema.transactionMatches)
      .where(eq(schema.transactionMatches.companyId, s.ctx.companyId));
    const taken = new Set(existing.map((m) => `${m.targetType}:${m.targetId}`));

    let sum = Money.zero(cur);
    let viaUndeposited = 0;
    const undeposited = await getAccountByRole(s, 'undeposited_funds').catch(() => null);
    const targetRows: { targetType: MatchInput['targets'][number]['targetType']; targetId: string; amount: Money; entryId: string }[] = [];
    for (const target of input.targets) {
      if (taken.has(`${target.targetType}:${target.targetId}`)) throw new ServiceError('duplicate', 'One of the selected records is already matched to another bank transaction.');
      let entryId: string;
      let effect: Money;
      let depositAccountId: string | null = null;
      if (target.targetType === 'payment') {
        const [p] = await s.tx.select().from(schema.payments).where(and(eq(schema.payments.companyId, s.ctx.companyId), eq(schema.payments.id, target.targetId)));
        if (!p || p.status !== 'posted') throw notFound('Payment');
        entryId = p.journalEntryId;
        effect = Money.round(p.amount, cur);
        depositAccountId = p.depositAccountId;
      } else if (target.targetType === 'purchase') {
        const [p] = await s.tx.select().from(schema.purchases).where(and(eq(schema.purchases.companyId, s.ctx.companyId), eq(schema.purchases.id, target.targetId)));
        if (!p || p.status !== 'posted') throw notFound('Purchase');
        if (p.paidFromAccountId !== ba.ledgerAccountId) throw new ServiceError('validation', 'That expense was paid from a different account.');
        entryId = p.journalEntryId;
        effect = p.direction === 'outflow' ? Money.round(p.total, cur).negate() : Money.round(p.total, cur);
      } else if (target.targetType === 'refund') {
        const [r] = await s.tx.select().from(schema.refunds).where(and(eq(schema.refunds.companyId, s.ctx.companyId), eq(schema.refunds.id, target.targetId)));
        if (!r || r.status !== 'posted') throw notFound('Refund');
        if (r.fromAccountId !== ba.ledgerAccountId) throw new ServiceError('validation', 'That refund was paid from a different account.');
        entryId = r.journalEntryId;
        effect = Money.round(r.amount, cur).negate();
      } else if (target.targetType === 'processor_payout') {
        const [po] = await s.tx.select().from(schema.processorPayouts).where(and(eq(schema.processorPayouts.companyId, s.ctx.companyId), eq(schema.processorPayouts.id, target.targetId)));
        if (!po || !po.journalEntryId) throw notFound('Payout');
        if (po.reversalEntryId) throw new ServiceError('invalid_state', 'This payout was reversed');
        const [line] = await s.tx.select().from(schema.journalLines).where(and(eq(schema.journalLines.entryId, po.journalEntryId), eq(schema.journalLines.accountId, ba.ledgerAccountId)));
        if (!line) throw new ServiceError('validation', 'That payout went to a different bank account.');
        entryId = po.journalEntryId;
        effect = Money.round(line.debit, cur).subtract(Money.round(line.credit, cur));
      } else {
        const [e] = await s.tx.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), eq(schema.journalEntries.id, target.targetId)));
        if (!e || e.status !== 'posted') throw notFound('Journal entry');
        const [line] = await s.tx.select().from(schema.journalLines).where(and(eq(schema.journalLines.entryId, e.id), eq(schema.journalLines.accountId, ba.ledgerAccountId)));
        if (!line) throw new ServiceError('validation', 'That journal entry doesn’t involve this bank account.');
        entryId = e.id;
        effect = Money.round(line.debit, cur).subtract(Money.round(line.credit, cur));
      }
      if (depositAccountId && undeposited && depositAccountId === undeposited.id) viaUndeposited++;
      else if (target.targetType === 'payment' && depositAccountId !== ba.ledgerAccountId) {
        throw new ServiceError('validation', 'That payment went into a different account.');
      }
      sum = sum.add(effect);
      targetRows.push({ targetType: target.targetType, targetId: target.targetId, amount: effect, entryId });
    }
    if (viaUndeposited > 0 && viaUndeposited !== targetRows.length) {
      throw new ServiceError('validation', 'Payments waiting to be deposited can’t be matched together with other records. Match them on their own.');
    }
    const fee = input.fee ? Money.of(input.fee.amount, cur) : Money.zero(cur);
    const expected = sum.subtract(fee);
    if (!expected.equals(amt)) {
      throw new ServiceError('validation', `The selected records (${plainMoney(sum, cur)}) minus the fee (${plainMoney(fee, cur)}) must add up to this transaction (${plainMoney(amt, cur)}).`);
    }
    let entryId: string | null = null;
    if (viaUndeposited > 0) {
      // Deposit entry: Dr bank (net) [+ Dr fee] / Cr undeposited funds (gross)
      const lines: EntryLineInput[] = [{ accountId: ba.ledgerAccountId, debit: amt, memo: `Deposit: ${t.description}` }];
      if (!fee.isZero()) lines.push({ accountId: input.fee!.accountId, debit: fee, memo: 'Processing fee' });
      lines.push({ accountId: undeposited!.id, credit: sum, memo: 'Deposited payments' });
      const entry = await postEntry(s, { date: t.date, memo: `Deposit: ${t.description}`, sourceType: 'transfer', sourceId: t.id, cashTreatment: 'include', lines });
      entryId = entry.id;
    } else if (!fee.isZero()) {
      const entry = await postEntry(s, {
        date: t.date,
        memo: `Fee on ${t.description}`,
        sourceType: 'bank_categorization',
        sourceId: t.id,
        cashTreatment: 'include',
        lines: [
          { accountId: input.fee!.accountId, debit: fee, memo: 'Bank/processor fee' },
          { accountId: ba.ledgerAccountId, credit: fee },
        ],
      });
      entryId = entry.id;
    }
    await s.tx.insert(schema.transactionMatches).values(
      targetRows.map((r) => ({ companyId: s.ctx.companyId, bankTransactionId: t.id, targetType: r.targetType, targetId: r.targetId, amount: r.amount.toString(), createdBy: s.ctx.actorId })),
    );
    const row = await markReviewed(s, id, input.version, { status: 'matched', journalEntryId: entryId ?? (targetRows.length === 1 ? targetRows[0]!.entryId : null) });
    await recordAudit(s, { action: 'bank_transaction.matched', entityType: 'bank_transaction', entityId: id, details: { targets: targetRows.length, fee: fee.toString(), entryId } });
    return toDto(row, ba.name);
  });
}

/**
 * "Customer paid an invoice": record a customer payment for the whole deposit
 * into this bank account, applied to the chosen invoices in due-date order
 * (the last may be paid in part; anything left over stays as credit for the
 * customer), and match the bank line to it. One transaction, one key.
 */
export async function recordInvoicePayment(s: ServiceContext, id: string, input: RecordInvoicePaymentInput): Promise<BankTransactionDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const t = await loadTxn(s, id);
    assertUnreviewed(t, input.version);
    const ba = await getBankAccount(s, t.bankAccountId);
    const cur = t.currency;
    const amt = Money.round(t.amount, cur);
    if (!amt.isPositive()) throw new ServiceError('validation', 'Only money coming in can pay an invoice.');
    const ids = [...new Set(input.invoiceIds)];
    const invoices = await s.tx
      .select()
      .from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, s.ctx.companyId), inArray(schema.invoices.id, ids)))
      .orderBy(asc(schema.invoices.dueDate), asc(schema.invoices.issueDate), asc(schema.invoices.number));
    if (invoices.length !== ids.length) throw notFound('Invoice');
    for (const inv of invoices) {
      if (inv.status !== 'issued' || !Money.round(inv.balanceDue, inv.currency).isPositive()) throw new ServiceError('invalid_state', `Invoice ${inv.number} is already paid or void. Reload to see its balance.`);
      if (inv.currency !== cur) throw new ServiceError('validation', `Invoice ${inv.number} is in ${inv.currency}, but this bank account is in ${cur}.`);
    }
    const contactId = invoices[0]!.contactId;
    if (invoices.some((inv) => inv.contactId !== contactId)) throw new ServiceError('validation', 'One deposit can pay invoices from one customer. Choose invoices from the same customer.');
    let left = amt;
    const allocations: { invoiceId: string; amount: string }[] = [];
    for (const inv of invoices) {
      if (left.isZero()) {
        throw new ServiceError('validation', `This deposit (${plainMoney(amt, cur)}) is used up before invoice ${inv.number}. Leave that invoice out.`);
      }
      const part = Money.round(inv.balanceDue, cur).min(left);
      allocations.push({ invoiceId: inv.id, amount: part.toString() });
      left = left.subtract(part);
    }
    const payment = await createPayment(s, {
      contactId,
      date: t.date,
      amount: amt.toString(),
      method: 'other',
      reference: t.reference ?? null,
      memo: t.description,
      depositAccountId: ba.ledgerAccountId,
      isRefundableDeposit: false,
      allocations,
      bankTransactionId: t.id,
    });
    await recordAudit(s, { action: 'bank_transaction.matched', entityType: 'bank_transaction', entityId: id, details: { paymentId: payment.id, invoices: allocations.length, credit: left.toString() } });
    return toDto(await loadTxn(s, id), ba.name);
  });
}

export async function excludeTransaction(s: ServiceContext, id: string, input: z.infer<typeof ExcludeInput>): Promise<BankTransactionDto> {
  const t = await loadTxn(s, id);
  assertUnreviewed(t, input.version);
  const row = await markReviewed(s, id, input.version, { status: 'excluded', excludedReason: input.reason });
  await recordAudit(s, { action: 'bank_transaction.excluded', entityType: 'bank_transaction', entityId: id, reason: input.reason });
  return toDto(row);
}

/**
 * Undo a review decision: reverse what it posted (purchase void or entry
 * reversal), drop match links, and put the transaction back in the inbox.
 * Records it was matched to stay, including a payment recorded from the line
 * ("Customer paid an invoice"); the line then offers that payment as a match.
 */
export async function undoReview(s: ServiceContext, id: string, input: z.infer<typeof UndoReviewInput>): Promise<BankTransactionDto> {
  return idempotent(s, input.idempotencyKey, { id, ...input }, async () => {
    const t = await loadTxn(s, id);
    if (t.version !== input.version) throw versionConflict('Bank transaction');
    if (t.status === 'unreviewed') throw new ServiceError('invalid_state', 'Transaction is not reviewed');
    const reason = input.reason ?? 'Review undone';
    const matches = await s.tx.select().from(schema.transactionMatches).where(and(eq(schema.transactionMatches.companyId, s.ctx.companyId), eq(schema.transactionMatches.bankTransactionId, id)));
    const purchaseMatch = matches.find((m) => m.targetType === 'purchase');
    if (t.status === 'categorized' && purchaseMatch) {
      const [p] = await s.tx.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseMatch.targetId));
      if (p && p.status === 'posted') await voidPurchase(s, p.id, { version: p.version, reason });
    } else if ((t.status === 'categorized' || t.status === 'transfer') && t.journalEntryId) {
      const [e] = await s.tx.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, t.journalEntryId));
      if (e && e.status === 'posted' && !e.reversedByEntryId) {
        const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, e.id)).orderBy(asc(schema.journalLines.lineNo));
        const reversal = await postEntry(s, {
          date: e.date,
          memo: `Undo review: ${reason}`,
          sourceType: 'reversal',
          sourceId: e.sourceId,
          cashTreatment: e.cashTreatment === 'derived' ? 'exclude' : e.cashTreatment,
          lines: lines.map((l) => ({ accountId: l.accountId, debit: Money.round(l.credit, t.currency), credit: Money.round(l.debit, t.currency), memo: l.memo, contactId: l.contactId })),
          reversesEntryId: e.id,
        });
        await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, e.id));
        await flagReconciliationsForEntry(s, e.id, `Bank review undone: ${reason}`);
      }
      // counterpart of a transfer goes back to the inbox too
      const counterpartIds = (await s.tx.select({ id: schema.bankTransactions.id, version: schema.bankTransactions.version }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), eq(schema.bankTransactions.journalEntryId, t.journalEntryId), ne(schema.bankTransactions.id, id))));
      for (const c of counterpartIds) {
        await s.tx.update(schema.bankTransactions).set({ status: 'unreviewed', journalEntryId: null, reviewedAt: null, reviewedBy: null }).where(eq(schema.bankTransactions.id, c.id));
        await s.tx.delete(schema.transactionMatches).where(eq(schema.transactionMatches.bankTransactionId, c.id));
      }
    } else if (t.status === 'matched' && t.journalEntryId) {
      // fee or deposit entry created by the match
      const [e] = await s.tx.select().from(schema.journalEntries).where(eq(schema.journalEntries.id, t.journalEntryId));
      if (e && e.status === 'posted' && !e.reversedByEntryId && e.sourceId === t.id) {
        const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, e.id)).orderBy(asc(schema.journalLines.lineNo));
        const reversal = await postEntry(s, {
          date: e.date,
          memo: `Undo match: ${reason}`,
          sourceType: 'reversal',
          sourceId: e.sourceId,
          cashTreatment: e.cashTreatment === 'derived' ? 'exclude' : e.cashTreatment,
          lines: lines.map((l) => ({ accountId: l.accountId, debit: Money.round(l.credit, t.currency), credit: Money.round(l.debit, t.currency), memo: l.memo, contactId: l.contactId })),
          reversesEntryId: e.id,
        });
        await s.tx.update(schema.journalEntries).set({ reversedByEntryId: reversal.id }).where(eq(schema.journalEntries.id, e.id));
        await flagReconciliationsForEntry(s, e.id, `Bank match undone: ${reason}`);
      }
    }
    await s.tx.delete(schema.transactionMatches).where(eq(schema.transactionMatches.bankTransactionId, id));
    const [row] = await s.tx
      .update(schema.bankTransactions)
      .set({ status: 'unreviewed', journalEntryId: null, excludedReason: null, reviewedAt: null, reviewedBy: null })
      .where(eq(schema.bankTransactions.id, id))
      .returning();
    await recordAudit(s, { action: 'bank_transaction.review_undone', entityType: 'bank_transaction', entityId: id, reason });
    return toDto(row!);
  });
}

// ---------------------------------------------------------------------------
// Bulk review
// ---------------------------------------------------------------------------

/** Expected failures become per-item results; anything else is a bug and fails the request. */
function bulkItemError(err: unknown): { code: string; message: string } {
  if (err instanceof ServiceError) return { code: err.code, message: err.message };
  const translated = translateDbError(err);
  if (translated) return { code: translated.code, message: translated.message };
  throw err;
}

async function bulkOne(s: ServiceContext, input: BulkReviewInput, item: { id: string; version: number }): Promise<BankTransactionDto> {
  switch (input.action) {
    case 'accept_suggestion': {
      const t = await loadTxn(s, item.id);
      assertUnreviewed(t, item.version);
      const rule = (await suggestRules(s, [t])).get(t.id);
      if (!rule) throw new ServiceError('validation', 'No rule suggests an account for this transaction');
      // A line that is probably already recorded (or pays an invoice) must be matched, not added again.
      const hint = (await matchHints(s, [t])).get(t.id);
      if (hint && (hint.count > 0 || hint.invoices > 0)) throw new ServiceError('duplicate', 'This looks already recorded. Open it and match it instead, so it isn’t counted twice.');
      return categorizeTransaction(s, item.id, {
        version: item.version,
        contactId: rule.contactId,
        memo: rule.memo,
        lines: [{ accountId: rule.accountId, amount: Money.round(t.amount, t.currency).abs().toString(), description: '' }],
      });
    }
    case 'categorize': {
      const t = await loadTxn(s, item.id);
      assertUnreviewed(t, item.version);
      return categorizeTransaction(s, item.id, {
        version: item.version,
        contactId: input.contactId ?? null,
        memo: input.memo ?? null,
        lines: [{ accountId: input.accountId, amount: Money.round(t.amount, t.currency).abs().toString(), description: '' }],
      });
    }
    case 'transfer': {
      const t = await loadTxn(s, item.id);
      assertUnreviewed(t, item.version);
      // Linking two imported sides needs individual review, not a second posting.
      const [counterpart] = await s.tx
        .select({ id: schema.bankTransactions.id })
        .from(schema.bankTransactions)
        .innerJoin(schema.bankAccounts, eq(schema.bankAccounts.id, schema.bankTransactions.bankAccountId))
        .where(and(
          eq(schema.bankTransactions.companyId, s.ctx.companyId),
          eq(schema.bankAccounts.ledgerAccountId, input.otherLedgerAccountId),
          ne(schema.bankTransactions.bankAccountId, t.bankAccountId),
          eq(schema.bankTransactions.status, 'unreviewed'),
          eq(schema.bankTransactions.currency, t.currency),
          eq(schema.bankTransactions.amount, Money.round(t.amount, t.currency).negate().toString()),
          gte(schema.bankTransactions.date, addDays(t.date, -5)),
          lte(schema.bankTransactions.date, addDays(t.date, 5)),
        ))
        .limit(1);
      if (counterpart) throw new ServiceError('validation', 'A possible other side is already imported in this account. Review this transaction individually to link both sides.');
      return transferTransaction(s, item.id, { version: item.version, otherLedgerAccountId: input.otherLedgerAccountId });
    }
    case 'exclude':
      return excludeTransaction(s, item.id, { version: item.version, reason: input.reason });
    case 'undo':
      return undoReview(s, item.id, { version: item.version, reason: input.reason });
  }
}

/**
 * Apply one review action to many bank lines. Each line runs in its own
 * savepoint, so a stale version or a closed period fails only that line; the
 * rest still commit, and the result reports every line. One idempotency key
 * covers the request: a retry returns the first run's results.
 */
export async function bulkReview(s: ServiceContext, input: BulkReviewInput): Promise<BulkReviewResultDto> {
  return idempotent(s, input.idempotencyKey, input, async () => {
    const seen = new Set<string>();
    const results: BulkReviewItemResult[] = [];
    for (const item of input.items) {
      if (seen.has(item.id)) {
        results.push({ id: item.id, ok: false, error: { code: 'duplicate', message: 'Listed more than once in this request' } });
        continue;
      }
      seen.add(item.id);
      try {
        const transaction = await s.tx.transaction((tx) => bulkOne({ ...s, tx }, input, item));
        results.push({ id: item.id, ok: true, transaction });
      } catch (err) {
        results.push({ id: item.id, ok: false, error: bulkItemError(err) });
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  });
}
