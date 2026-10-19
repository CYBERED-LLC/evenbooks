import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import type { ImportCashComponentInput, ReviewImportedCashInput } from '@evenbooks/contracts';
import type { ServiceContext } from './context';
import { ServiceError, notFound, versionConflict } from './errors';
import { recordAudit } from './audit';
import { getEntry } from './ledger';

export async function validateImportedCashComponents(s: ServiceContext, input: ImportCashComponentInput[]): Promise<schema.ImportCashComponent[]> {
  const components: schema.ImportCashComponent[] = [];
  const seen = new Set<string>();
  for (const c of input) {
    if (seen.has(c.accountId)) throw new ServiceError('validation', 'Each cash-basis account may appear only once');
    seen.add(c.accountId);
    const [a] = await s.tx.select().from(schema.accounts).where(and(eq(schema.accounts.companyId, s.ctx.companyId), eq(schema.accounts.id, c.accountId)));
    if (!a || !a.isActive || a.currency !== s.company.baseCurrency || (a.type !== 'income' && a.type !== 'expense')) throw new ServiceError('validation', 'Choose an active income or expense account in this company');
    const amount = Money.of(c.amount, s.company.baseCurrency);
    if (amount.isZero()) throw new ServiceError('validation', 'Cash-basis amounts must be nonzero; remove unused lines');
    components.push({ accountId: a.id, amount: amount.toString(), kind: a.type });
  }
  return components;
}

/** Explicit review can correct old imports without changing their accrual ledger. */
export async function reviewImportedCash(s: ServiceContext, id: string, input: ReviewImportedCashInput) {
  const [entry] = await s.tx.select().from(schema.journalEntries).where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), eq(schema.journalEntries.id, id))).for('update');
  if (!entry) throw notFound('Journal entry');
  if (entry.sourceType !== 'import' || entry.status !== 'posted') throw new ServiceError('invalid_state', 'Only posted imported entries accept a cash-basis review');
  if (entry.version !== input.version) throw versionConflict('Journal entry');
  // Lock parents before children, matching reversal creation, so a new reversal
  // cannot race this correction. Depth determines the sign of the cash amounts.
  const affected = [{ entry, depth: 0 }];
  let frontier = [id];
  let depth = 1;
  while (frontier.length) {
    const children = await s.tx.select().from(schema.journalEntries)
      .where(and(eq(schema.journalEntries.companyId, s.ctx.companyId), inArray(schema.journalEntries.reversesEntryId, frontier)))
      .orderBy(asc(schema.journalEntries.id)).for('update');
    affected.push(...children.map(entry => ({ entry, depth })));
    frontier = children.map(e => e.id);
    depth++;
  }
  const dates = await s.tx.execute<{ locked: boolean }>(sql`select app.is_date_locked(${s.ctx.companyId}::uuid, date) as locked from journal_entries where id in (${sql.join(affected.map(x => sql`${x.entry.id}`), sql`,`)})`);
  if (dates.rows.some(r => r.locked)) throw new ServiceError('period_locked', 'Reopen the affected accounting periods before correcting cash-basis amounts');
  const components = await validateImportedCashComponents(s, input.components);
  let before = entry.cashComponents;
  if (before === null) {
    const lines = await s.tx.select({ accountId: schema.accounts.id, kind: schema.accounts.type, debit: schema.journalLines.debit, credit: schema.journalLines.credit })
      .from(schema.journalLines).innerJoin(schema.accounts, eq(schema.accounts.id, schema.journalLines.accountId)).where(eq(schema.journalLines.entryId, id));
    before = entry.cashTreatment === 'include' ? lines.filter(l => l.kind === 'income' || l.kind === 'expense').map(l => ({
      accountId: l.accountId, kind: l.kind as 'income' | 'expense',
      amount: (l.kind === 'income' ? Money.round(l.credit, entry.currency).subtract(Money.round(l.debit, entry.currency)) : Money.round(l.debit, entry.currency).subtract(Money.round(l.credit, entry.currency))).toString(),
    })) : [];
  }
  const deltas = new Map<string, { kind: 'income' | 'expense'; amount: Money }>();
  for (const [rows, sign] of [[before, -1], [components, 1]] as const) for (const c of rows) {
    const amount = Money.of(c.amount, entry.currency);
    const prior = deltas.get(c.accountId)?.amount ?? Money.zero(entry.currency);
    deltas.set(c.accountId, { kind: c.kind, amount: prior.add(sign === 1 ? amount : amount.negate()) });
  }
  await s.tx.update(schema.journalEntries).set({ cashComponents: components }).where(eq(schema.journalEntries.id, id));
  const corrections = affected.flatMap(({ entry: e, depth }) => [...deltas].filter(([, c]) => !c.amount.isZero()).map(([accountId, c]) => ({
    companyId: s.ctx.companyId, date: e.date, accountId, amount: (depth % 2 ? c.amount.negate() : c.amount).toString(),
    kind: c.kind, eventType: 'import_cash_correction', eventId: e.id, journalEntryId: e.id, documentType: 'import', documentId: entry.sourceId,
  })));
  if (corrections.length) await s.tx.insert(schema.cashRecognitions).values(corrections);
  await recordAudit(s, { action: 'journal.import_cash_reviewed', entityType: 'journal_entry', entityId: id, reason: input.reason, details: { before: entry.cashComponents, after: components } });
  return getEntry(s, id);
}

/** Never silently present an incomplete cash report from historical settlements. */
export async function assertImportedCashReviewed(s: ServiceContext, from: string, to: string) {
  const unresolved = await s.tx.execute<{ id: string; entry_number: string }>(sql`
    with recursive import_history as (
      select id as root_id, id, date from journal_entries where company_id=${s.ctx.companyId} and source_type='import' and status='posted' and cash_components is null
      union all select h.root_id, r.id, r.date from journal_entries r join import_history h on r.reverses_entry_id=h.id where r.company_id=${s.ctx.companyId} and r.status='posted'
    )
    select e.id, e.entry_number from journal_entries e
    where e.company_id = ${s.ctx.companyId} and e.source_type = 'import' and e.status = 'posted' and e.cash_components is null
      and exists (select 1 from import_history h where h.root_id=e.id and h.date between ${from}::date and ${to}::date)
      and exists (select 1 from journal_lines l join accounts a on a.id=l.account_id where l.entry_id=e.id and a.role in ('bank','credit_card','undeposited_funds'))
      and exists (select 1 from journal_lines l join accounts a on a.id=l.account_id where l.entry_id=e.id and a.type in ('asset','liability') and coalesce(a.role::text,'') not in ('bank','credit_card','undeposited_funds'))
    order by e.entry_number limit 1`);
  const e = unresolved.rows[0];
  if (e) throw new ServiceError('invalid_state', `Imported entry #${e.entry_number} needs a quick review before cash-basis reports can include it. Open it from Settings → Import data.`, { journalEntryId: e.id });
}
