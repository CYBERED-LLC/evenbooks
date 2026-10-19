import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { todayInTimeZone } from '@evenbooks/domain';
import type { AccountDto, CreateAccountInput, UpdateAccountInput, AccountRole } from '@evenbooks/contracts';
import { ServiceError, notFound, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { setMappings } from './reports-more';

type AccountRow = typeof schema.accounts.$inferSelect;

export function toAccountDto(a: AccountRow, balance?: string): AccountDto {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    type: a.type,
    role: a.role,
    parentId: a.parentId,
    description: a.description,
    currency: a.currency,
    isActive: a.isActive,
    isSystem: a.isSystem,
    version: a.version,
    ...(balance !== undefined ? { balance } : {}),
  };
}

export async function listAccounts(s: ServiceContext, opts: { includeArchived?: boolean; withBalances?: boolean } = {}): Promise<AccountDto[]> {
  const conds = [eq(schema.accounts.companyId, s.ctx.companyId)];
  if (!opts.includeArchived) conds.push(eq(schema.accounts.isActive, true));
  const rows = await s.tx
    .select()
    .from(schema.accounts)
    .where(and(...conds))
    .orderBy(asc(schema.accounts.code));
  if (!opts.withBalances) return rows.map((r) => toAccountDto(r));
  const balances = await s.tx.execute<{ account_id: string; balance: string }>(
    sql`select account_id, balance from account_balances where company_id = ${s.ctx.companyId}`,
  );
  const byId = new Map(balances.rows.map((b) => [b.account_id, b.balance]));
  return rows.map((r) => toAccountDto(r, byId.get(r.id) ?? '0'));
}

export async function getAccount(s: ServiceContext, id: string): Promise<AccountRow> {
  const [row] = await s.tx
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, s.ctx.companyId), eq(schema.accounts.id, id)))
    .limit(1);
  if (!row) throw notFound('Account');
  return row;
}

export async function getAccountByRole(s: ServiceContext, role: AccountRole): Promise<AccountRow> {
  const [row] = await s.tx
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.companyId, s.ctx.companyId), eq(schema.accounts.role, role), eq(schema.accounts.isActive, true)))
    .limit(1);
  if (!row) throw new ServiceError('invalid_state', `Your books are missing the built-in ${role.replace(/_/g, ' ')} account. Restore it in the chart of accounts (Show archived).`);
  return row;
}

export async function createAccount(s: ServiceContext, input: CreateAccountInput): Promise<AccountDto> {
  if (input.parentId) {
    const parent = await getAccount(s, input.parentId);
    if (parent.type !== input.type) throw new ServiceError('validation', 'Parent account must have the same type');
  }
  const [row] = await s.tx
    .insert(schema.accounts)
    .values({
      companyId: s.ctx.companyId,
      code: input.code.trim(),
      name: input.name.trim(),
      type: input.type,
      role: input.role ?? null,
      parentId: input.parentId ?? null,
      description: input.description ?? null,
      currency: s.company.baseCurrency,
    })
    .returning();
  await recordAudit(s, { action: 'account.created', entityType: 'account', entityId: row!.id, details: { code: row!.code, name: row!.name, type: row!.type } });
  // A new category goes straight onto its tax-form line, so Schedule C never shows it as unmapped.
  if (input.scheduleCLine && (input.type === 'income' || input.type === 'expense')) {
    const taxYear = Number(todayInTimeZone(s.company.timeZone).slice(0, 4));
    await setMappings(s, taxYear, [{ accountId: row!.id, lineCode: input.scheduleCLine }]);
  }
  return toAccountDto(row!);
}

export async function updateAccount(s: ServiceContext, id: string, input: UpdateAccountInput): Promise<AccountDto> {
  const current = await getAccount(s, id);
  if (input.isActive === false && current.isSystem) {
    throw new ServiceError('validation', 'System accounts cannot be archived');
  }
  if (input.parentId) {
    if (input.parentId === id) throw new ServiceError('validation', 'An account cannot be its own parent');
    const parent = await getAccount(s, input.parentId);
    if (parent.type !== current.type) throw new ServiceError('validation', 'Parent account must have the same type');
  }
  const { version, ...rest } = input;
  const [row] = await s.tx
    .update(schema.accounts)
    .set({ ...rest, code: rest.code?.trim(), name: rest.name?.trim() })
    .where(and(eq(schema.accounts.companyId, s.ctx.companyId), eq(schema.accounts.id, id), eq(schema.accounts.version, version)))
    .returning();
  if (!row) throw versionConflict('Account');
  await recordAudit(s, {
    action: input.isActive === false ? 'account.archived' : input.isActive === true && !current.isActive ? 'account.restored' : 'account.updated',
    entityType: 'account',
    entityId: id,
    details: { fields: Object.keys(rest) },
  });
  return toAccountDto(row);
}
