import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import type { BankAccountDto, CreateBankAccountInput } from '@evenbooks/contracts';
import { ServiceError, notFound, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { getAccount } from './accounts';

type BankAccountRow = typeof schema.bankAccounts.$inferSelect;

export async function listBankAccounts(s: ServiceContext, opts: { includeInactive?: boolean } = {}): Promise<BankAccountDto[]> {
  const conds = [eq(schema.bankAccounts.companyId, s.ctx.companyId)];
  if (!opts.includeInactive) conds.push(eq(schema.bankAccounts.isActive, true));
  const rows = await s.tx
    .select({
      ba: schema.bankAccounts,
      code: schema.accounts.code,
      ledgerName: schema.accounts.name,
    })
    .from(schema.bankAccounts)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.bankAccounts.ledgerAccountId))
    .where(and(...conds))
    .orderBy(asc(schema.bankAccounts.name));
  const balances = await s.tx.execute<{ account_id: string; balance: string }>(
    sql`select account_id, balance from account_balances where company_id = ${s.ctx.companyId} and role in ('bank','credit_card')`,
  );
  const balanceById = new Map(balances.rows.map((b) => [b.account_id, b.balance]));
  const unreviewed = await s.tx.execute<{ bank_account_id: string; n: string }>(
    sql`select bank_account_id, count(*)::text as n from bank_transactions where company_id = ${s.ctx.companyId} and status = 'unreviewed' group by bank_account_id`,
  );
  const unreviewedById = new Map(unreviewed.rows.map((u) => [u.bank_account_id, Number(u.n)]));
  return rows.map(({ ba, code, ledgerName }) => toDto(ba, code, ledgerName, balanceById.get(ba.ledgerAccountId), unreviewedById.get(ba.id) ?? 0));
}

function toDto(ba: BankAccountRow, code?: string, ledgerName?: string, ledgerBalance?: string, unreviewedCount?: number): BankAccountDto {
  return {
    id: ba.id,
    name: ba.name,
    kind: ba.kind,
    ledgerAccountId: ba.ledgerAccountId,
    ledgerAccountCode: code,
    ledgerAccountName: ledgerName,
    connectionId: ba.connectionId,
    providerAccountId: ba.providerAccountId,
    providerOrgName: ba.providerOrgName,
    currency: ba.currency,
    lastBalance: ba.lastBalance ? Money.round(ba.lastBalance, ba.currency).toString() : null,
    lastBalanceAt: ba.lastBalanceAt,
    lastSyncedAt: ba.lastSyncedAt,
    ledgerBalance: ledgerBalance !== undefined ? Money.round(ledgerBalance, ba.currency).toString() : undefined,
    unreviewedCount,
    isActive: ba.isActive,
    version: ba.version,
  };
}

export async function getBankAccount(s: ServiceContext, id: string): Promise<BankAccountRow> {
  const [row] = await s.tx
    .select()
    .from(schema.bankAccounts)
    .where(and(eq(schema.bankAccounts.companyId, s.ctx.companyId), eq(schema.bankAccounts.id, id)))
    .limit(1);
  if (!row) throw notFound('Bank account');
  return row;
}

export async function createBankAccount(s: ServiceContext, input: CreateBankAccountInput): Promise<BankAccountDto> {
  let ledgerAccountId = input.ledgerAccountId;
  if (!ledgerAccountId) {
    if (!input.newLedgerAccount) throw new ServiceError('validation', 'Choose an account in the chart of accounts, or give a code and name for a new one.');
    const [acct] = await s.tx
      .insert(schema.accounts)
      .values({
        companyId: s.ctx.companyId,
        code: input.newLedgerAccount.code.trim(),
        name: input.newLedgerAccount.name.trim(),
        type: input.kind === 'bank' ? 'asset' : 'liability',
        role: input.kind === 'bank' ? 'bank' : 'credit_card',
        currency: s.company.baseCurrency,
      })
      .returning();
    ledgerAccountId = acct!.id;
  } else {
    const a = await getAccount(s, ledgerAccountId);
    const expectedRole = input.kind === 'bank' ? 'bank' : 'credit_card';
    if (a.role !== expectedRole) throw new ServiceError('validation', `Choose an account set up as a ${expectedRole === 'credit_card' ? 'credit card' : 'bank account'}`);
  }
  const [row] = await s.tx
    .insert(schema.bankAccounts)
    .values({ companyId: s.ctx.companyId, ledgerAccountId, name: input.name.trim(), kind: input.kind, currency: s.company.baseCurrency })
    .returning();
  await recordAudit(s, { action: 'bank_account.created', entityType: 'bank_account', entityId: row!.id, details: { name: row!.name, kind: row!.kind } });
  const [a] = await s.tx.select({ code: schema.accounts.code, name: schema.accounts.name }).from(schema.accounts).where(eq(schema.accounts.id, ledgerAccountId));
  return toDto(row!, a?.code, a?.name, '0', 0);
}

export async function updateBankAccount(s: ServiceContext, id: string, input: { version: number; name?: string; isActive?: boolean }): Promise<BankAccountDto> {
  const { version, ...rest } = input;
  const [row] = await s.tx
    .update(schema.bankAccounts)
    .set(rest)
    .where(and(eq(schema.bankAccounts.companyId, s.ctx.companyId), eq(schema.bankAccounts.id, id), eq(schema.bankAccounts.version, version)))
    .returning();
  if (!row) throw versionConflict('Bank account');
  await recordAudit(s, { action: 'bank_account.updated', entityType: 'bank_account', entityId: id, details: { fields: Object.keys(rest) } });
  return toDto(row);
}
