import { and, asc, eq, inArray, lte, or, isNull, sql } from 'drizzle-orm';
import { schema, withSystem, type Db } from '@evenbooks/db';
import { Money, addDays, todayInTimeZone } from '@evenbooks/domain';
import { SecretBox, SimpleFinError, type SimpleFinAccount, type SimpleFinAccountsResponse, type SimpleFinClient } from '@evenbooks/integrations';
import type { BankConnectionDto, ConnectSimpleFinInput, DiscoveredAccountDto, LinkProviderAccountsInput, SyncResultDto } from '@evenbooks/contracts';
import { ServiceError, notFound, versionConflict } from './errors';
import { runJobInCompany, type ServiceContext } from './context';
import { recordAudit } from './audit';
import { createBankAccount, getBankAccount } from './bank-accounts';

type ConnectionRow = typeof schema.bankConnections.$inferSelect;

/** Bridge caps ranges at 90 days; we overlap windows by 5 days to catch late-posting items. */
const OVERLAP_DAYS = 5;
const MAX_WINDOW_DAYS = 89;
const INITIAL_WINDOW_DAYS = 60;
/** SimpleFIN recommends at most 45 days per request; longer windows are fetched in chunks. */
const CHUNK_DAYS = 45;

function box(): SecretBox {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key) throw new ServiceError('internal', 'APP_ENCRYPTION_KEY is required for bank connections');
  return new SecretBox(key);
}

function isStale(c: ConnectionRow, now = new Date()): boolean {
  if (c.status !== 'active') return c.status === 'error';
  if (!c.lastSuccessAt) return c.createdAt < new Date(now.getTime() - 2 * c.syncIntervalMinutes * 60_000).toISOString();
  return c.lastSuccessAt < new Date(now.getTime() - 2 * c.syncIntervalMinutes * 60_000).toISOString();
}

async function toDtos(s: ServiceContext, rows: ConnectionRow[], withAccounts: boolean): Promise<BankConnectionDto[]> {
  const accounts = withAccounts && rows.length
    ? await s.tx.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.companyId, s.ctx.companyId), inArray(schema.bankAccounts.connectionId, rows.map((r) => r.id))))
    : [];
  return rows.map((r) => ({
    id: r.id,
    provider: 'simplefin',
    name: r.name,
    status: r.status,
    syncIntervalMinutes: r.syncIntervalMinutes,
    nextSyncAt: r.nextSyncAt,
    lastSyncStartedAt: r.lastSyncStartedAt,
    lastSuccessAt: r.lastSuccessAt,
    lastError: r.lastError,
    lastErrorAt: r.lastErrorAt,
    consecutiveFailures: r.consecutiveFailures,
    isStale: isStale(r),
    accounts: withAccounts
      ? accounts
          .filter((a) => a.connectionId === r.id)
          .map((a) => ({ id: a.id, name: a.name, kind: a.kind, providerAccountId: a.providerAccountId, providerOrgName: a.providerOrgName, lastBalance: a.lastBalance ? Money.round(a.lastBalance, a.currency).toString() : null, lastBalanceAt: a.lastBalanceAt, lastSyncedAt: a.lastSyncedAt }))
      : undefined,
    version: r.version,
    createdAt: r.createdAt,
  }));
}

export async function listConnections(s: ServiceContext): Promise<BankConnectionDto[]> {
  const rows = await s.tx.select().from(schema.bankConnections).where(eq(schema.bankConnections.companyId, s.ctx.companyId)).orderBy(asc(schema.bankConnections.name));
  return toDtos(s, rows, true);
}

async function loadConnection(s: ServiceContext, id: string, forUpdate = false): Promise<ConnectionRow> {
  const q = s.tx
    .select()
    .from(schema.bankConnections)
    .where(and(eq(schema.bankConnections.companyId, s.ctx.companyId), eq(schema.bankConnections.id, id)))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  if (!row) throw notFound('Bank connection');
  return row;
}

export async function getConnection(s: ServiceContext, id: string): Promise<BankConnectionDto> {
  return (await toDtos(s, [await loadConnection(s, id)], true))[0]!;
}

/**
 * Claim a setup token (one-time), encrypt the returned access URL, and store the
 * connection. The token itself is never persisted or logged. Network calls
 * happen before the transaction writes; the caller runs this outside any ledger
 * transaction.
 */
export async function connectSimpleFin(s: ServiceContext, client: SimpleFinClient, input: ConnectSimpleFinInput): Promise<BankConnectionDto> {
  let accessUrl: string;
  try {
    accessUrl = await client.claimSetupToken(input.setupToken);
  } catch (err) {
    if (err instanceof SimpleFinError) throw new ServiceError('external_error', err.message, { kind: err.kind });
    throw err;
  }
  const ciphertext = box().encrypt(accessUrl);
  const [row] = await s.tx
    .insert(schema.bankConnections)
    .values({
      companyId: s.ctx.companyId,
      provider: 'simplefin',
      name: input.name.trim(),
      accessUrlCiphertext: ciphertext,
      syncIntervalMinutes: input.syncIntervalMinutes,
      nextSyncAt: new Date().toISOString(),
      createdBy: s.ctx.actorId,
    })
    .returning();
  await recordAudit(s, { action: 'bank_connection.created', entityType: 'bank_connection', entityId: row!.id, details: { name: row!.name, provider: 'simplefin' } });
  return getConnection(s, row!.id);
}

/** Accounts visible at the provider, with existing links (balances only; no transactions). */
export async function discoverAccounts(s: ServiceContext, client: SimpleFinClient, connectionId: string): Promise<DiscoveredAccountDto[]> {
  const c = await loadConnection(s, connectionId);
  const accessUrl = box().decrypt(c.accessUrlCiphertext);
  let res;
  try {
    res = await client.fetchAccounts(accessUrl, { startDate: new Date(), endDate: new Date() });
  } catch (err) {
    if (err instanceof SimpleFinError) throw new ServiceError('external_error', err.message, { kind: err.kind });
    throw err;
  }
  const linked = await s.tx.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.companyId, s.ctx.companyId), eq(schema.bankAccounts.connectionId, connectionId)));
  const byProvider = new Map(linked.map((l) => [l.providerAccountId, l.id]));
  return res.accounts.map((a) => ({
    providerAccountId: a.id,
    name: a.name,
    orgName: a.orgName,
    currency: a.currency,
    balance: a.balance ? Money.round(a.balance, 'USD').toString() : null,
    balanceDate: a.balanceDate ? new Date(a.balanceDate * 1000).toISOString() : null,
    bankAccountId: byProvider.get(a.id) ?? null,
  }));
}

export async function linkProviderAccounts(s: ServiceContext, connectionId: string, input: LinkProviderAccountsInput): Promise<BankConnectionDto> {
  const c = await loadConnection(s, connectionId, true);
  if (c.version !== input.version) throw versionConflict('Bank connection');
  for (const link of input.links) {
    let bankAccountId = link.bankAccountId;
    if (!bankAccountId) {
      if (!link.create) throw new ServiceError('validation', 'Provide a bank account to link or details to create one');
      const created = await createBankAccount(s, { name: link.create.name, kind: link.create.kind, ledgerAccountId: link.create.ledgerAccountId, newLedgerAccount: link.create.newLedgerAccount });
      bankAccountId = created.id;
    }
    const ba = await getBankAccount(s, bankAccountId);
    if (ba.connectionId && ba.connectionId !== connectionId) throw new ServiceError('validation', `${ba.name} is already linked to another connection`);
    await s.tx.update(schema.bankAccounts).set({ connectionId, providerAccountId: link.providerAccountId }).where(eq(schema.bankAccounts.id, bankAccountId));
  }
  // Newly linked accounts should be pulled right away: due now for the worker, and not throttled for "Sync now".
  await s.tx.update(schema.bankConnections).set({ nextSyncAt: new Date().toISOString(), lastSyncStartedAt: null }).where(eq(schema.bankConnections.id, connectionId));
  await recordAudit(s, { action: 'bank_connection.accounts_linked', entityType: 'bank_connection', entityId: connectionId, details: { count: input.links.length } });
  return getConnection(s, connectionId);
}

export async function updateConnection(s: ServiceContext, id: string, input: { version: number; name?: string; syncIntervalMinutes?: number; status?: 'active' | 'disabled' }): Promise<BankConnectionDto> {
  const c = await loadConnection(s, id, true);
  if (c.version !== input.version) throw versionConflict('Bank connection');
  if (c.status === 'revoked' && input.status === 'active') throw new ServiceError('invalid_state', 'Revoked connections must be reconnected with a new setup token');
  const { version: _version, ...rest } = input;
  await s.tx
    .update(schema.bankConnections)
    .set({ ...rest, ...(input.status === 'active' ? { consecutiveFailures: 0, lastError: null, nextSyncAt: new Date().toISOString() } : {}) })
    .where(eq(schema.bankConnections.id, id));
  await recordAudit(s, { action: 'bank_connection.updated', entityType: 'bank_connection', entityId: id, details: { fields: Object.keys(rest) } });
  return getConnection(s, id);
}

/** Reconnect with a fresh token, keeping account links and history. */
export async function reconnectSimpleFin(s: ServiceContext, client: SimpleFinClient, id: string, input: { version: number; setupToken: string }): Promise<BankConnectionDto> {
  const c = await loadConnection(s, id, true);
  if (c.version !== input.version) throw versionConflict('Bank connection');
  let accessUrl: string;
  try {
    accessUrl = await client.claimSetupToken(input.setupToken);
  } catch (err) {
    if (err instanceof SimpleFinError) throw new ServiceError('external_error', err.message, { kind: err.kind });
    throw err;
  }
  await s.tx
    .update(schema.bankConnections)
    .set({ accessUrlCiphertext: box().encrypt(accessUrl), keyVersion: 1, status: 'active', consecutiveFailures: 0, lastError: null, lastErrorAt: null, nextSyncAt: new Date().toISOString() })
    .where(eq(schema.bankConnections.id, id));
  await recordAudit(s, { action: 'bank_connection.reconnected', entityType: 'bank_connection', entityId: id });
  return getConnection(s, id);
}

/** Disconnect: credentials are destroyed; imported transactions and history remain. */
export async function disconnect(s: ServiceContext, id: string, version: number): Promise<BankConnectionDto> {
  const c = await loadConnection(s, id, true);
  if (c.version !== version) throw versionConflict('Bank connection');
  await s.tx.update(schema.bankConnections).set({ status: 'revoked', accessUrlCiphertext: 'revoked', nextSyncAt: null }).where(eq(schema.bankConnections.id, id));
  await recordAudit(s, { action: 'bank_connection.disconnected', entityType: 'bank_connection', entityId: id });
  return getConnection(s, id);
}

/** Connections due for polling (system context; cross-company). */
export async function dueConnections(db: Db, now = new Date()): Promise<{ id: string; companyId: string }[]> {
  return withSystem(db, async (tx) =>
    tx
      .select({ id: schema.bankConnections.id, companyId: schema.bankConnections.companyId })
      .from(schema.bankConnections)
      .where(and(eq(schema.bankConnections.status, 'active'), or(isNull(schema.bankConnections.nextSyncAt), lte(schema.bankConnections.nextSyncAt, now.toISOString()))))
      .limit(200),
  );
}

/**
 * Fetch [windowStart, windowEnd] (inclusive dates) in chunks of at most
 * CHUNK_DAYS, oldest first, and merge the responses. Transactions are
 * de-duplicated by provider id; account metadata comes from the latest chunk.
 */
async function fetchWindow(client: SimpleFinClient, accessUrl: string, windowStart: string, windowEnd: string): Promise<SimpleFinAccountsResponse> {
  const endExclusive = addDays(windowEnd, 1);
  const merged = new Map<string, SimpleFinAccount>();
  const errors: string[] = [];
  for (let start = windowStart; start < endExclusive; start = addDays(start, CHUNK_DAYS)) {
    const chunkEnd = addDays(start, CHUNK_DAYS) < endExclusive ? addDays(start, CHUNK_DAYS) : endExclusive;
    const res = await client.fetchAccounts(accessUrl, { startDate: new Date(`${start}T00:00:00Z`), endDate: new Date(`${chunkEnd}T00:00:00Z`), pending: true });
    for (const e of res.errors) if (!errors.includes(e)) errors.push(e);
    for (const acct of res.accounts) {
      const prev = merged.get(acct.id);
      const seen = new Map((prev?.transactions ?? []).map((t) => [t.id, t]));
      for (const t of acct.transactions) seen.set(t.id, t);
      merged.set(acct.id, { ...acct, transactions: [...seen.values()] });
    }
  }
  return { accounts: [...merged.values()], errors };
}

/**
 * Sync one connection. Runs as three steps so the network call is never inside
 * a database transaction:
 *   1. claim (mark started, compute window) — committed
 *   2. fetch from the provider
 *   3. upsert transactions + status — committed
 *
 * Identity is the provider transaction id. Pending items are updated in place
 * when they post; amount/date/description changes on already-imported rows are
 * flagged (`changed_at`, `change_note`) and never rewrite a posted journal.
 */
export async function syncConnection(db: Db, client: SimpleFinClient, companyId: string, connectionId: string, jobId?: string, now = new Date()): Promise<SyncResultDto> {
  const ctx = { companyId, actorId: 'bank-sync', actorType: 'job' as const, jobId };
  const claim = await runJobInCompany(db, ctx, async (s) => {
    const c = await loadConnection(s, connectionId, true);
    if (c.status !== 'active') return null;
    const accounts = await s.tx.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.companyId, companyId), eq(schema.bankAccounts.connectionId, connectionId), eq(schema.bankAccounts.isActive, true)));
    // Throttle: never poll the same connection more than once per 15 minutes even if asked to.
    // Exception: a linked account that has never been synced (the worker typically polls a new
    // connection before its accounts are linked) must not make the user wait out the window.
    const neverSynced = accounts.some((a) => !a.lastSyncedAt);
    if (!neverSynced && c.lastSyncStartedAt && new Date(c.lastSyncStartedAt).getTime() > now.getTime() - 15 * 60_000 && !process.env.EVENBOOKS_SYNC_NO_THROTTLE) {
      return { throttled: true as const };
    }
    const today = todayInTimeZone(s.company.timeZone, now);
    // Incremental window from the last success, unless an account has never been synced:
    // a connection's first success may predate its account links, and those accounts
    // still need the full initial history.
    const startDate = c.lastSuccessAt && !neverSynced ? addDays(c.lastSuccessAt.slice(0, 10), -OVERLAP_DAYS) : addDays(today, -INITIAL_WINDOW_DAYS);
    const boundedStart = startDate < addDays(today, -MAX_WINDOW_DAYS) ? addDays(today, -MAX_WINDOW_DAYS) : startDate;
    await s.tx.update(schema.bankConnections).set({ lastSyncStartedAt: now.toISOString() }).where(eq(schema.bankConnections.id, connectionId));
    return { throttled: false as const, accessUrl: box().decrypt(c.accessUrlCiphertext), windowStart: boundedStart, windowEnd: today, accounts, interval: c.syncIntervalMinutes, timeZone: s.company.timeZone };
  });
  if (!claim) return { connectionId, ok: false, inserted: 0, updated: 0, changed: 0, windowStart: null, windowEnd: null, error: 'Connection is not active', warnings: [] };
  if (claim.throttled) return { connectionId, ok: true, inserted: 0, updated: 0, changed: 0, windowStart: null, windowEnd: null, error: null, warnings: ['Throttled: synced less than 15 minutes ago'] };

  let response;
  try {
    response = await fetchWindow(client, claim.accessUrl, claim.windowStart, claim.windowEnd);
  } catch (err) {
    const e = err instanceof SimpleFinError ? err : new SimpleFinError((err as Error).message, 'network');
    await runJobInCompany(db, ctx, async (s) => {
      const c = await loadConnection(s, connectionId, true);
      const failures = c.consecutiveFailures + 1;
      const revoked = e.kind === 'auth_revoked' || e.kind === 'payment_required';
      // exponential backoff up to 24h; revoked connections stop polling until reconnected
      const backoffMinutes = Math.min(24 * 60, c.syncIntervalMinutes * 2 ** Math.min(failures, 5));
      await s.tx
        .update(schema.bankConnections)
        .set({
          status: revoked ? 'revoked' : failures >= 3 ? 'error' : 'active',
          lastError: e.message,
          lastErrorAt: now.toISOString(),
          consecutiveFailures: failures,
          nextSyncAt: revoked ? null : new Date(now.getTime() + backoffMinutes * 60_000).toISOString(),
        })
        .where(eq(schema.bankConnections.id, connectionId));
      await recordAudit(s, { action: 'bank_connection.sync_failed', entityType: 'bank_connection', entityId: connectionId, details: { kind: e.kind, message: e.message, failures } });
    });
    return { connectionId, ok: false, inserted: 0, updated: 0, changed: 0, windowStart: claim.windowStart, windowEnd: claim.windowEnd, error: e.message, warnings: [] };
  }

  return runJobInCompany(db, ctx, async (s) => {
    let inserted = 0;
    let updated = 0;
    let changed = 0;
    const byProvider = new Map(claim.accounts.map((a) => [a.providerAccountId!, a]));
    for (const acct of response.accounts) {
      const ba = byProvider.get(acct.id);
      if (!ba) continue; // not linked; discoverable later
      const ids = acct.transactions.map((t) => t.id);
      const existing = ids.length
        ? await s.tx.select().from(schema.bankTransactions).where(and(eq(schema.bankTransactions.companyId, companyId), eq(schema.bankTransactions.bankAccountId, ba.id), inArray(schema.bankTransactions.providerTxnId, ids)))
        : [];
      const byId = new Map(existing.map((e) => [e.providerTxnId!, e]));
      // Lines deleted permanently in Evenbooks stay deleted.
      const deleted = ids.length
        ? new Set((await s.tx.select({ id: schema.deletedBankTransactions.providerTxnId }).from(schema.deletedBankTransactions).where(and(eq(schema.deletedBankTransactions.companyId, companyId), eq(schema.deletedBankTransactions.bankAccountId, ba.id), inArray(schema.deletedBankTransactions.providerTxnId, ids)))).map((r) => r.id!))
        : new Set<string>();
      for (const t of acct.transactions) {
        const amount = Money.round(t.amount, ba.currency).toString();
        const cur = byId.get(t.id);
        if (!cur && deleted.has(t.id)) continue;
        if (!cur) {
          await s.tx
            .insert(schema.bankTransactions)
            .values({
              companyId,
              bankAccountId: ba.id,
              source: 'simplefin',
              providerTxnId: t.id,
              date: t.date,
              amount,
              currency: ba.currency,
              description: t.description || t.payee || '(no description)',
              payee: t.payee,
              memo: t.memo,
              pending: t.pending,
              raw: t.raw,
              lastSeenAt: now.toISOString(),
            })
            .onConflictDoNothing();
          inserted++;
          continue;
        }
        const diffs: string[] = [];
        if (Money.round(cur.amount, ba.currency).toString() !== amount) diffs.push(`amount ${Money.round(cur.amount, ba.currency).toString()} → ${amount}`);
        if (cur.date !== t.date) diffs.push(`date ${cur.date} → ${t.date}`);
        if (cur.description !== (t.description || t.payee || '(no description)')) diffs.push(`description changed`);
        const becamePosted = cur.pending && !t.pending;
        if (diffs.length === 0 && !becamePosted) {
          await s.tx.update(schema.bankTransactions).set({ lastSeenAt: now.toISOString() }).where(eq(schema.bankTransactions.id, cur.id));
          continue;
        }
        if (cur.status === 'unreviewed') {
          // Not yet acted on: safe to update in place (pending → posted, provider corrections).
          await s.tx
            .update(schema.bankTransactions)
            .set({ date: t.date, amount, description: t.description || t.payee || cur.description, payee: t.payee, memo: t.memo, pending: t.pending, raw: t.raw, lastSeenAt: now.toISOString(), ...(diffs.length ? { changedAt: now.toISOString(), changeNote: `Provider update: ${diffs.join('; ')}` } : {}) })
            .where(eq(schema.bankTransactions.id, cur.id));
          updated++;
        } else {
          // Already categorized/matched: never rewrite; flag for human review.
          await s.tx
            .update(schema.bankTransactions)
            .set({ pending: t.pending, lastSeenAt: now.toISOString(), ...(diffs.length ? { changedAt: now.toISOString(), changeNote: `Provider changed a reviewed transaction: ${diffs.join('; ')}. Review the posted entry.` } : {}) })
            .where(eq(schema.bankTransactions.id, cur.id));
          if (diffs.length) changed++;
        }
      }
      await s.tx
        .update(schema.bankAccounts)
        .set({ lastBalance: acct.balance ? Money.round(acct.balance, ba.currency).toString() : ba.lastBalance, lastBalanceAt: acct.balanceDate ? new Date(acct.balanceDate * 1000).toISOString() : ba.lastBalanceAt, lastSyncedAt: now.toISOString(), providerOrgName: acct.orgName ?? ba.providerOrgName })
        .where(eq(schema.bankAccounts.id, ba.id));
    }
    const warnings = response.errors;
    await s.tx
      .update(schema.bankConnections)
      .set({ lastSuccessAt: now.toISOString(), consecutiveFailures: 0, lastError: warnings.length ? `Provider warnings: ${warnings.join('; ')}` : null, lastErrorAt: warnings.length ? now.toISOString() : null, status: 'active', nextSyncAt: new Date(now.getTime() + claim.interval * 60_000).toISOString() })
      .where(eq(schema.bankConnections.id, connectionId));
    await recordAudit(s, { action: 'bank_connection.synced', entityType: 'bank_connection', entityId: connectionId, details: { inserted, updated, changed, windowStart: claim.windowStart, windowEnd: claim.windowEnd, warnings } });
    return { connectionId, ok: true, inserted, updated, changed, windowStart: claim.windowStart, windowEnd: claim.windowEnd, error: null, warnings };
  });
}

export { sql };
