import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import type { CreateRuleInput, RuleDto, UpdateRuleInput } from '@evenbooks/contracts';
import { ServiceError, notFound, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { getAccount } from './accounts';

type RuleRow = typeof schema.categorizationRules.$inferSelect;
type TxnRow = typeof schema.bankTransactions.$inferSelect;

export function toRuleDto(r: RuleRow, accountName?: string): RuleDto {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    bankAccountId: r.bankAccountId,
    direction: r.direction,
    matchField: r.matchField,
    matchType: r.matchType,
    pattern: r.pattern,
    amountMin: r.amountMin,
    amountMax: r.amountMax,
    accountId: r.accountId,
    accountName,
    contactId: r.contactId,
    memo: r.memo,
    isActive: r.isActive,
    hitCount: r.hitCount,
    version: r.version,
  };
}

export async function listRules(s: ServiceContext): Promise<RuleDto[]> {
  const rows = await s.tx
    .select({ r: schema.categorizationRules, accountName: schema.accounts.name })
    .from(schema.categorizationRules)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.categorizationRules.accountId))
    .where(eq(schema.categorizationRules.companyId, s.ctx.companyId))
    .orderBy(asc(schema.categorizationRules.priority), asc(schema.categorizationRules.name));
  return rows.map(({ r, accountName }) => toRuleDto(r, accountName));
}

function validatePattern(matchType: string, pattern: string): void {
  if (matchType === 'regex') throw new ServiceError('validation', 'Regular expression rules are no longer supported; choose a text match');
  if (pattern.length > 200) throw new ServiceError('validation', 'Pattern too long');
}

export async function createRule(s: ServiceContext, input: CreateRuleInput): Promise<RuleDto> {
  validatePattern(input.matchType, input.pattern);
  const a = await getAccount(s, input.accountId);
  const [row] = await s.tx
    .insert(schema.categorizationRules)
    .values({
      companyId: s.ctx.companyId,
      name: input.name.trim(),
      priority: input.priority,
      bankAccountId: input.bankAccountId ?? null,
      direction: input.direction,
      matchField: input.matchField,
      matchType: input.matchType,
      pattern: input.pattern,
      amountMin: input.amountMin ?? null,
      amountMax: input.amountMax ?? null,
      accountId: input.accountId,
      contactId: input.contactId ?? null,
      memo: input.memo ?? null,
    })
    .returning();
  await recordAudit(s, { action: 'rule.created', entityType: 'categorization_rule', entityId: row!.id, details: { name: row!.name, pattern: row!.pattern } });
  return toRuleDto(row!, a.name);
}

export async function updateRule(s: ServiceContext, id: string, input: UpdateRuleInput): Promise<RuleDto> {
  const [existing] = await s.tx.select().from(schema.categorizationRules).where(and(eq(schema.categorizationRules.companyId, s.ctx.companyId), eq(schema.categorizationRules.id, id)));
  if (!existing) throw notFound('Rule');
  validatePattern(input.matchType ?? existing.matchType, input.pattern ?? existing.pattern);
  if (input.accountId) await getAccount(s, input.accountId);
  const { version, ...rest } = input;
  const [row] = await s.tx
    .update(schema.categorizationRules)
    .set(rest)
    .where(and(eq(schema.categorizationRules.id, id), eq(schema.categorizationRules.version, version)))
    .returning();
  if (!row) throw versionConflict('Rule');
  await recordAudit(s, { action: 'rule.updated', entityType: 'categorization_rule', entityId: id, details: { fields: Object.keys(rest) } });
  const [a] = await s.tx.select({ name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, row.accountId));
  return toRuleDto(row, a?.name);
}

export async function deleteRule(s: ServiceContext, id: string): Promise<void> {
  const res = await s.tx.delete(schema.categorizationRules).where(and(eq(schema.categorizationRules.companyId, s.ctx.companyId), eq(schema.categorizationRules.id, id))).returning({ id: schema.categorizationRules.id });
  if (!res.length) throw notFound('Rule');
  await recordAudit(s, { action: 'rule.deleted', entityType: 'categorization_rule', entityId: id });
}

export function ruleMatches(rule: RuleRow, txn: Pick<TxnRow, 'description' | 'payee' | 'amount' | 'bankAccountId'>): boolean {
  if (rule.bankAccountId && rule.bankAccountId !== txn.bankAccountId) return false;
  const amt = Money.round(txn.amount, 'USD');
  if (rule.direction === 'in' && !amt.isPositive()) return false;
  if (rule.direction === 'out' && !amt.isNegative()) return false;
  const abs = amt.abs();
  if (rule.amountMin && abs.lt(Money.round(rule.amountMin, 'USD'))) return false;
  if (rule.amountMax && abs.gt(Money.round(rule.amountMax, 'USD'))) return false;
  const fields = rule.matchField === 'description' ? [txn.description] : rule.matchField === 'payee' ? [txn.payee ?? ''] : [txn.description, txn.payee ?? ''];
  const pattern = rule.pattern.toLowerCase();
  return fields.some((f) => {
    const v = (f ?? '').toLowerCase();
    switch (rule.matchType) {
      case 'contains':
        return v.includes(pattern);
      case 'starts_with':
        return v.startsWith(pattern);
      case 'equals':
        return v.trim() === pattern.trim();
      case 'regex':
        return false; // Legacy rules must never execute on the server's event loop.
    }
  });
}

/** First active rule (by priority) matching each transaction. Suggestions only; never posts. */
export async function suggestRules(s: ServiceContext, txns: Pick<TxnRow, 'id' | 'description' | 'payee' | 'amount' | 'bankAccountId'>[]): Promise<Map<string, RuleRow>> {
  const out = new Map<string, RuleRow>();
  if (txns.length === 0) return out;
  const rules = await s.tx
    .select()
    .from(schema.categorizationRules)
    .where(and(eq(schema.categorizationRules.companyId, s.ctx.companyId), eq(schema.categorizationRules.isActive, true)))
    .orderBy(asc(schema.categorizationRules.priority), asc(schema.categorizationRules.createdAt));
  for (const t of txns) {
    const r = rules.find((rule) => ruleMatches(rule, t));
    if (r) out.set(t.id, r);
  }
  return out;
}

export async function bumpRuleHit(s: ServiceContext, ruleId: string): Promise<void> {
  await s.tx.update(schema.categorizationRules).set({ hitCount: sql`${schema.categorizationRules.hitCount} + 1` }).where(eq(schema.categorizationRules.id, ruleId));
}
