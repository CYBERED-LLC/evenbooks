import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { schema, withSystem, type CompanyContext, type Db } from '@evenbooks/db';
import { Money, computePlatformFee, proportionalFeeRefund, reverseLines, todayInTimeZone, totalFeePercent, type EntryLineInput, type PlatformFeeConfig, DEFAULT_PLATFORM_FEE } from '@evenbooks/domain';
import type { PaymentProcessorClient, ProcessorEvent } from '@evenbooks/integrations';
import { PaymentProcessorError, sha256Hex } from '@evenbooks/integrations';
import type {
  ListProcessorChargesQuery,
  ProcessorChargeDto,
  ProcessorConnectionDto,
  ProcessorPayoutDto,
  ProcessorRefundDto,
  PublicCheckoutInput,
  PublicOnlinePaymentDto,
  RefundProcessorChargeInput,
  UpdateProcessorConnectionInput,
} from '@evenbooks/contracts';
import { ServiceError, notFound, unwrapDbError, versionConflict, withDbErrors } from './errors';
import { runInCompany, runJobInCompany, type ServiceContext } from './context';
import { recordAudit } from './audit';
import { postEntry } from './ledger';
import { getBankAccount } from './bank-accounts';
import { allocatePayment, createPayment, getPayment, reverseAllocation } from './payments';
import { createRefund } from './refunds';
import { loadInvoice } from './invoices';

/**
 * Online payments (Stripe Connect, Standard accounts, direct charges).
 * Design: docs/payments-plan.md. Every ledger effect here goes through the
 * same services a bookkeeper would use by hand (createPayment, createRefund,
 * postEntry), so cash/accrual reports and the audit trail need nothing new.
 */

type ConnectionRow = typeof schema.paymentProcessorConnections.$inferSelect;
type ChargeRow = typeof schema.processorCharges.$inferSelect;
type RefundRow = typeof schema.processorRefunds.$inferSelect;
type PayoutRow = typeof schema.processorPayouts.$inferSelect;

export const PROCESSOR_ACTOR = 'processor:stripe';

export interface ProcessorDeps {
  client: PaymentProcessorClient;
  feeConfig?: PlatformFeeConfig;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------
async function toConnectionDto(s: ServiceContext, c: ConnectionRow, client: PaymentProcessorClient, feeConfig: PlatformFeeConfig): Promise<ProcessorConnectionDto> {
  const accts = await s.tx
    .select({ id: schema.accounts.id, name: schema.accounts.name })
    .from(schema.accounts)
    .where(inArray(schema.accounts.id, [c.clearingAccountId, c.feeAccountId]));
  const name = new Map(accts.map((a) => [a.id, a.name]));
  const bank = c.payoutBankAccountId ? await getBankAccount(s, c.payoutBankAccountId).catch(() => null) : null;
  const bal = await s.tx.execute<{ balance: string }>(sql`select balance from account_balances where company_id = ${s.ctx.companyId} and account_id = ${c.clearingAccountId}`);
  const cur = s.company.baseCurrency;
  return {
    id: c.id,
    provider: c.provider,
    providerAccountId: c.providerAccountId,
    status: c.status,
    chargesEnabled: c.chargesEnabled,
    payoutsEnabled: c.payoutsEnabled,
    detailsSubmitted: c.detailsSubmitted,
    displayName: c.displayName,
    origin: c.origin,
    linkedBalance: c.linkedBalance == null ? null : Money.round(c.linkedBalance, cur).toString(),
    linkedAt: c.linkedAt,
    clearingAccountId: c.clearingAccountId,
    clearingAccountName: name.get(c.clearingAccountId) ?? 'Stripe balance',
    feeAccountId: c.feeAccountId,
    feeAccountName: name.get(c.feeAccountId) ?? 'Merchant processing fees',
    payoutBankAccountId: c.payoutBankAccountId,
    payoutBankAccountName: bank?.name ?? null,
    allowCard: c.allowCard,
    allowAch: c.allowAch,
    allowPartial: c.allowPartial,
    minimumPayment: Money.round(c.minimumPayment, cur).toString(),
    autoPostPayouts: c.autoPostPayouts,
    lastEventAt: c.lastEventAt,
    lastError: c.lastError,
    dashboardUrl: client.dashboardUrl(c.providerAccountId),
    platformFee: { plan: s.company.plan, cardTotalPercent: totalFeePercent(s.company.plan, 'card', feeConfig), achTotalPercent: totalFeePercent(s.company.plan, 'ach', feeConfig) },
    clearingBalance: Money.round(bal.rows[0]?.balance ?? '0', cur).toString(),
    version: c.version,
    createdAt: c.createdAt,
  };
}

async function toChargeDtos(s: ServiceContext, rows: ChargeRow[]): Promise<ProcessorChargeDto[]> {
  if (rows.length === 0) return [];
  const cur = s.company.baseCurrency;
  const invoiceIds = [...new Set(rows.map((r) => r.invoiceId).filter((x): x is string => Boolean(x)))];
  const contactIds = [...new Set(rows.map((r) => r.contactId).filter((x): x is string => Boolean(x)))];
  const invoices = invoiceIds.length ? await s.tx.select({ id: schema.invoices.id, number: schema.invoices.number }).from(schema.invoices).where(inArray(schema.invoices.id, invoiceIds)) : [];
  const contacts = contactIds.length ? await s.tx.select({ id: schema.contacts.id, name: schema.contacts.name }).from(schema.contacts).where(inArray(schema.contacts.id, contactIds)) : [];
  const invNo = new Map(invoices.map((i) => [i.id, i.number]));
  const cName = new Map(contacts.map((c) => [c.id, c.name]));
  return rows.map((r) => {
    const amount = Money.round(r.amount, cur);
    const refundable = r.status === 'succeeded' ? amount.subtract(Money.round(r.amountRefunded, cur)).subtract(Money.round(r.amountDisputed, cur)).max(Money.zero(cur)) : Money.zero(cur);
    return {
      id: r.id,
      provider: r.provider as 'stripe',
      providerPaymentIntentId: r.providerPaymentIntentId,
      providerChargeId: r.providerChargeId,
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceId ? invNo.get(r.invoiceId) ?? null : null,
      contactId: r.contactId,
      contactName: r.contactId ? cName.get(r.contactId) ?? null : null,
      origin: r.origin,
      method: r.method,
      status: r.status,
      currency: r.currency,
      amount: amount.toString(),
      processorFee: Money.round(r.processorFee, cur).toString(),
      platformFee: Money.round(r.platformFee, cur).toString(),
      platformFeeRefunded: Money.round(r.platformFeeRefunded, cur).toString(),
      amountRefunded: Money.round(r.amountRefunded, cur).toString(),
      amountDisputed: Money.round(r.amountDisputed, cur).toString(),
      refundableAmount: refundable.toString(),
      paymentId: r.paymentId,
      feeJournalEntryId: r.feeJournalEntryId,
      payerEmail: r.payerEmail,
      description: r.description,
      failureMessage: r.failureMessage,
      succeededAt: r.succeededAt,
      createdAt: r.createdAt,
      version: r.version,
    };
  });
}

function toRefundDto(r: RefundRow, cur: string): ProcessorRefundDto {
  return {
    id: r.id,
    chargeId: r.chargeId,
    providerRefundId: r.providerRefundId,
    providerDisputeId: r.providerDisputeId,
    kind: r.kind,
    origin: r.origin,
    status: r.status,
    amount: Money.round(r.amount, cur).toString(),
    feeAmount: Money.round(r.feeAmount, cur).toString(),
    platformFeeRefunded: Money.round(r.platformFeeRefunded, cur).toString(),
    reason: r.reason,
    disputeStatus: r.disputeStatus,
    refundId: r.refundId,
    paymentId: r.paymentId,
    failureMessage: r.failureMessage,
    createdAt: r.createdAt,
  };
}

async function toPayoutDtos(s: ServiceContext, rows: PayoutRow[]): Promise<ProcessorPayoutDto[]> {
  const bankIds = [...new Set(rows.map((r) => r.bankAccountId).filter((x): x is string => Boolean(x)))];
  const banks = bankIds.length ? await s.tx.select({ id: schema.bankAccounts.id, name: schema.bankAccounts.name }).from(schema.bankAccounts).where(inArray(schema.bankAccounts.id, bankIds)) : [];
  const bName = new Map(banks.map((b) => [b.id, b.name]));
  return rows.map((r) => ({
    id: r.id,
    providerPayoutId: r.providerPayoutId,
    status: r.status,
    currency: r.currency,
    amount: Money.round(r.amount, r.currency).toString(),
    arrivalDate: r.arrivalDate,
    description: r.description,
    bankAccountId: r.bankAccountId,
    bankAccountName: r.bankAccountId ? bName.get(r.bankAccountId) ?? null : null,
    journalEntryId: r.journalEntryId,
    reversalEntryId: r.reversalEntryId,
    failureMessage: r.failureMessage,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------
async function liveConnection(s: ServiceContext, forUpdate = false): Promise<ConnectionRow | null> {
  const q = s.tx
    .select()
    .from(schema.paymentProcessorConnections)
    .where(and(eq(schema.paymentProcessorConnections.companyId, s.ctx.companyId), sql`${schema.paymentProcessorConnections.status} <> 'disconnected'`))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export async function getProcessorConnection(s: ServiceContext, deps: ProcessorDeps): Promise<ProcessorConnectionDto | null> {
  const c = await liveConnection(s);
  return c ? toConnectionDto(s, c, deps.client, deps.feeConfig ?? DEFAULT_PLATFORM_FEE) : null;
}

/** Find or create the system accounts the processor posts to. Reused across reconnects. */
async function ensureProcessorAccounts(s: ServiceContext): Promise<{ clearingId: string; feeId: string }> {
  const find = async (role: 'processor_clearing' | 'processor_fees') => {
    const [row] = await s.tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(and(eq(schema.accounts.companyId, s.ctx.companyId), eq(schema.accounts.role, role)))
      .orderBy(desc(schema.accounts.isActive), asc(schema.accounts.code))
      .limit(1);
    if (row) {
      await s.tx.update(schema.accounts).set({ isActive: true }).where(eq(schema.accounts.id, row.id));
      return row.id;
    }
    return null;
  };
  const freeCode = async (start: number) => {
    const codes = new Set((await s.tx.select({ code: schema.accounts.code }).from(schema.accounts).where(eq(schema.accounts.companyId, s.ctx.companyId))).map((r) => r.code));
    for (let c = start; c < start + 50; c++) if (!codes.has(String(c))) return String(c);
    throw new ServiceError('invalid_state', 'No free account code near ' + start);
  };
  let clearingId = await find('processor_clearing');
  if (!clearingId) {
    const [row] = await s.tx
      .insert(schema.accounts)
      .values({ companyId: s.ctx.companyId, code: await freeCode(1055), name: 'Stripe balance', type: 'asset', role: 'processor_clearing', isSystem: true, currency: s.company.baseCurrency, description: 'Funds collected online, held by Stripe until paid out. Returns to zero after each payout.' })
      .returning({ id: schema.accounts.id });
    clearingId = row!.id;
  }
  let feeId = await find('processor_fees');
  if (!feeId) {
    const [row] = await s.tx
      .insert(schema.accounts)
      .values({ companyId: s.ctx.companyId, code: await freeCode(5175), name: 'Merchant processing fees', type: 'expense', role: 'processor_fees', isSystem: true, currency: s.company.baseCurrency, description: 'Card and bank-debit processing fees (Stripe) and Evenbooks platform fees on online payments.' })
      .returning({ id: schema.accounts.id });
    feeId = row!.id;
    // Schedule C line 10 (commissions and fees) for the current year, like Bank Fees
    const year = new Date().getUTCFullYear();
    await s.tx.insert(schema.taxFormMappings).values({ companyId: s.ctx.companyId, taxYear: year, accountId: feeId, lineCode: '10' }).onConflictDoNothing();
  }
  return { clearingId, feeId };
}

function accountStatus(a: { chargesEnabled: boolean; detailsSubmitted: boolean }): ConnectionRow['status'] {
  if (a.chargesEnabled) return 'active';
  if (a.detailsSubmitted) return 'restricted';
  return 'pending';
}

/**
 * Start (or resume) connecting Stripe. Creates the connected account and the
 * clearing/fee accounts, then returns the hosted onboarding URL.
 */
export async function connectProcessor(s: ServiceContext, deps: ProcessorDeps, input: { returnUrl: string; refreshUrl: string }): Promise<{ connection: ProcessorConnectionDto; onboardingUrl: string }> {
  const feeConfig = deps.feeConfig ?? DEFAULT_PLATFORM_FEE;
  let conn = await liveConnection(s, true);
  if (!conn) {
    const account = await deps.client.createConnectedAccount({ email: s.company.email, businessName: s.company.legalName ?? s.company.name });
    const { clearingId, feeId } = await ensureProcessorAccounts(s);
    const [row] = await s.tx
      .insert(schema.paymentProcessorConnections)
      .values({
        companyId: s.ctx.companyId,
        provider: deps.client.provider,
        providerAccountId: account.id,
        status: accountStatus(account),
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
        detailsSubmitted: account.detailsSubmitted,
        displayName: account.displayName,
        clearingAccountId: clearingId,
        feeAccountId: feeId,
        createdBy: s.ctx.actorId,
      })
      .returning();
    conn = row!;
    await recordAudit(s, { action: 'processor.connected', entityType: 'processor_connection', entityId: conn.id, details: { provider: conn.provider, providerAccountId: conn.providerAccountId } });
  }
  const link = await deps.client.createOnboardingLink({ accountId: conn.providerAccountId, returnUrl: input.returnUrl, refreshUrl: input.refreshUrl });
  return { connection: await toConnectionDto(s, conn, deps.client, feeConfig), onboardingUrl: link.url };
}

/**
 * A pending connection that never took a payment can make way for a linked
 * account: typically the administrator clicked "create" first and then
 * remembered they already have Stripe.
 */
async function isReplaceable(s: ServiceContext, conn: ConnectionRow): Promise<boolean> {
  if (conn.status === 'active') return false;
  const [charge] = await s.tx.select({ id: schema.processorCharges.id }).from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), eq(schema.processorCharges.connectionId, conn.id))).limit(1);
  if (charge) return false;
  const [payout] = await s.tx.select({ id: schema.processorPayouts.id }).from(schema.processorPayouts).where(and(eq(schema.processorPayouts.companyId, s.ctx.companyId), eq(schema.processorPayouts.connectionId, conn.id))).limit(1);
  return !payout;
}

/**
 * Check that linking is possible before sending the administrator to Stripe,
 * and return the provider's authorization URL.
 */
export async function startProcessorLink(s: ServiceContext, deps: ProcessorDeps, input: { state: string; redirectUri: string }): Promise<{ url: string }> {
  if (!deps.client.supportsLinking) throw new ServiceError('invalid_state', 'Connecting an existing Stripe account is not enabled on this server');
  const conn = await liveConnection(s);
  if (conn && !(await isReplaceable(s, conn))) throw new ServiceError('invalid_state', 'Disconnect the current Stripe account before connecting a different one');
  return { url: deps.client.createLinkUrl({ state: input.state, redirectUri: input.redirectUri, email: s.company.email, businessName: s.company.legalName ?? s.company.name }) };
}

/**
 * Finish linking an existing Stripe account (OAuth callback). Replaces an
 * unused pending connection, reactivates this company's earlier connection to
 * the same account, and refuses an account another company already uses.
 */
export async function linkProcessorAccount(s: ServiceContext, deps: ProcessorDeps, input: { code: string }): Promise<ProcessorConnectionDto> {
  const feeConfig = deps.feeConfig ?? DEFAULT_PLATFORM_FEE;
  if (!deps.client.supportsLinking) throw new ServiceError('invalid_state', 'Connecting an existing Stripe account is not enabled on this server');
  const { accountId } = await deps.client.completeLink(input.code);
  const account = await deps.client.retrieveAccount(accountId);
  const cur = s.company.baseCurrency;
  if (account.defaultCurrency && account.defaultCurrency !== cur) {
    throw new ServiceError('validation', `This Stripe account settles in ${account.defaultCurrency}, but the company's books are in ${cur}`);
  }
  const live = await liveConnection(s, true);
  if (live && live.providerAccountId !== accountId) {
    if (!(await isReplaceable(s, live))) throw new ServiceError('invalid_state', 'Disconnect the current Stripe account before connecting a different one');
    await s.tx.update(schema.paymentProcessorConnections).set({ status: 'disconnected', disconnectedAt: new Date().toISOString() }).where(eq(schema.paymentProcessorConnections.id, live.id));
    await recordAudit(s, { action: 'processor.disconnected', entityType: 'processor_connection', entityId: live.id, details: { reason: 'replaced_by_linked_account', providerAccountId: live.providerAccountId } });
  }
  const balance = await deps.client.retrieveBalance(accountId, cur).catch(() => null);
  const flags = { status: accountStatus(account), chargesEnabled: account.chargesEnabled, payoutsEnabled: account.payoutsEnabled, detailsSubmitted: account.detailsSubmitted, lastError: account.disabledReason, lastErrorAt: account.disabledReason ? new Date().toISOString() : null };
  const [previous] = await s.tx
    .select()
    .from(schema.paymentProcessorConnections)
    .where(and(eq(schema.paymentProcessorConnections.companyId, s.ctx.companyId), eq(schema.paymentProcessorConnections.provider, deps.client.provider), eq(schema.paymentProcessorConnections.providerAccountId, accountId)))
    .for('update');
  let row: ConnectionRow;
  if (previous) {
    // This company used the account before (reconnect after a disconnect): keep its history and accounts.
    const [u] = await s.tx
      .update(schema.paymentProcessorConnections)
      .set({ ...flags, displayName: account.displayName ?? previous.displayName, disconnectedAt: null })
      .where(eq(schema.paymentProcessorConnections.id, previous.id))
      .returning();
    row = u!;
  } else {
    const { clearingId, feeId } = await ensureProcessorAccounts(s);
    try {
      const [created] = await s.tx
        .insert(schema.paymentProcessorConnections)
        .values({
          companyId: s.ctx.companyId,
          provider: deps.client.provider,
          providerAccountId: accountId,
          ...flags,
          displayName: account.displayName,
          origin: 'linked',
          linkedBalance: balance,
          linkedAt: new Date().toISOString(),
          clearingAccountId: clearingId,
          feeAccountId: feeId,
          createdBy: s.ctx.actorId,
        })
        .returning();
      row = created!;
    } catch (err) {
      // The account id is unique across companies and RLS hides the other company's row.
      if (unwrapDbError(err)?.code === '23505') throw new ServiceError('conflict', 'This Stripe account is already connected to another Evenbooks company');
      throw err;
    }
  }
  await recordAudit(s, { action: 'processor.linked', entityType: 'processor_connection', entityId: row.id, details: { provider: row.provider, providerAccountId: accountId, stripeBalance: balance } });
  return toConnectionDto(s, row, deps.client, feeConfig);
}

/** Pull the account's current capability flags (after onboarding returns, or on demand). */
export async function refreshProcessorConnection(s: ServiceContext, deps: ProcessorDeps): Promise<ProcessorConnectionDto> {
  const conn = await liveConnection(s, true);
  if (!conn) throw notFound('Payment processor connection');
  const account = await deps.client.retrieveAccount(conn.providerAccountId);
  const [row] = await s.tx
    .update(schema.paymentProcessorConnections)
    .set({ status: accountStatus(account), chargesEnabled: account.chargesEnabled, payoutsEnabled: account.payoutsEnabled, detailsSubmitted: account.detailsSubmitted, displayName: account.displayName ?? conn.displayName, lastError: account.disabledReason, lastErrorAt: account.disabledReason ? new Date().toISOString() : null })
    .where(eq(schema.paymentProcessorConnections.id, conn.id))
    .returning();
  return toConnectionDto(s, row!, deps.client, deps.feeConfig ?? DEFAULT_PLATFORM_FEE);
}

export async function updateProcessorConnection(s: ServiceContext, deps: ProcessorDeps, input: UpdateProcessorConnectionInput): Promise<ProcessorConnectionDto> {
  const conn = await liveConnection(s, true);
  if (!conn) throw notFound('Payment processor connection');
  if (conn.version !== input.version) throw versionConflict('Payment processor connection');
  if (input.payoutBankAccountId) {
    const ba = await getBankAccount(s, input.payoutBankAccountId);
    if (ba.kind !== 'bank') throw new ServiceError('validation', 'Payouts land in a bank account, not a credit card');
  }
  const allowCard = input.allowCard ?? conn.allowCard;
  const allowAch = input.allowAch ?? conn.allowAch;
  if (!allowCard && !allowAch) throw new ServiceError('validation', 'Enable at least one payment method');
  const [row] = await s.tx
    .update(schema.paymentProcessorConnections)
    .set({
      payoutBankAccountId: input.payoutBankAccountId === undefined ? conn.payoutBankAccountId : input.payoutBankAccountId,
      allowCard,
      allowAch,
      allowPartial: input.allowPartial ?? conn.allowPartial,
      minimumPayment: input.minimumPayment !== undefined ? Money.of(input.minimumPayment, s.company.baseCurrency).toString() : conn.minimumPayment,
      autoPostPayouts: input.autoPostPayouts ?? conn.autoPostPayouts,
    })
    .where(eq(schema.paymentProcessorConnections.id, conn.id))
    .returning();
  await recordAudit(s, { action: 'processor.settings_updated', entityType: 'processor_connection', entityId: conn.id, details: { ...input } });
  return toConnectionDto(s, row!, deps.client, deps.feeConfig ?? DEFAULT_PLATFORM_FEE);
}

/** Stop offering online payments. The Stripe account stays the company's; events for it keep posting so the books stay whole. */
export async function disconnectProcessor(s: ServiceContext, deps: ProcessorDeps, input: { version: number }): Promise<ProcessorConnectionDto> {
  const conn = await liveConnection(s, true);
  if (!conn) throw notFound('Payment processor connection');
  if (conn.version !== input.version) throw versionConflict('Payment processor connection');
  const [row] = await s.tx
    .update(schema.paymentProcessorConnections)
    .set({ status: 'disconnected', disconnectedAt: new Date().toISOString() })
    .where(eq(schema.paymentProcessorConnections.id, conn.id))
    .returning();
  await recordAudit(s, { action: 'processor.disconnected', entityType: 'processor_connection', entityId: conn.id });
  return toConnectionDto(s, row!, deps.client, deps.feeConfig ?? DEFAULT_PLATFORM_FEE);
}

// ---------------------------------------------------------------------------
// Charges, refunds, payouts (company-facing reads)
// ---------------------------------------------------------------------------
export async function listProcessorCharges(s: ServiceContext, q: ListProcessorChargesQuery): Promise<ProcessorChargeDto[]> {
  const conds = [eq(schema.processorCharges.companyId, s.ctx.companyId)];
  if (q.invoiceId) conds.push(eq(schema.processorCharges.invoiceId, q.invoiceId));
  if (q.status) conds.push(eq(schema.processorCharges.status, q.status));
  const rows = await s.tx
    .select()
    .from(schema.processorCharges)
    .where(and(...conds))
    .orderBy(desc(schema.processorCharges.createdAt))
    .limit(q.limit);
  return toChargeDtos(s, rows);
}

export async function getProcessorCharge(s: ServiceContext, id: string): Promise<ProcessorChargeDto & { refunds: ProcessorRefundDto[] }> {
  const [row] = await s.tx.select().from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), eq(schema.processorCharges.id, id))).limit(1);
  if (!row) throw notFound('Online payment');
  const [dto] = await toChargeDtos(s, [row]);
  const refunds = await s.tx.select().from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.chargeId, id))).orderBy(asc(schema.processorRefunds.createdAt));
  return { ...dto!, refunds: refunds.map((r) => toRefundDto(r, s.company.baseCurrency)) };
}

export async function listProcessorPayouts(s: ServiceContext, limit = 50): Promise<ProcessorPayoutDto[]> {
  const rows = await s.tx.select().from(schema.processorPayouts).where(eq(schema.processorPayouts.companyId, s.ctx.companyId)).orderBy(desc(schema.processorPayouts.arrivalDate), desc(schema.processorPayouts.createdAt)).limit(limit);
  return toPayoutDtos(s, rows);
}

/** Problems for the jobs page: events whose processing failed and is still pending retry. */
export async function processorEventProblems(s: ServiceContext, limit = 50) {
  const rows = await s.tx
    .select({ id: schema.processorEvents.id, eventType: schema.processorEvents.eventType, receivedAt: schema.processorEvents.receivedAt, attempts: schema.processorEvents.attempts, lastError: schema.processorEvents.lastError })
    .from(schema.processorEvents)
    .where(and(eq(schema.processorEvents.companyId, s.ctx.companyId), isNull(schema.processorEvents.processedAt), sql`${schema.processorEvents.lastError} is not null`))
    .orderBy(desc(schema.processorEvents.receivedAt))
    .limit(limit);
  return rows;
}

// ---------------------------------------------------------------------------
// Public checkout
// ---------------------------------------------------------------------------
async function processingAmountForInvoice(s: ServiceContext, invoiceId: string): Promise<Money> {
  const cur = s.company.baseCurrency;
  const rows = await s.tx
    .select({ amount: schema.processorCharges.amount })
    .from(schema.processorCharges)
    .where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), eq(schema.processorCharges.invoiceId, invoiceId), eq(schema.processorCharges.status, 'processing')));
  return Money.sum(rows.map((r) => Money.round(r.amount, cur)), cur);
}

/** What the public invoice page needs to render a pay button (null = not payable online). */
export async function publicOnlinePaymentInfo(s: ServiceContext, inv: { id: string; status: string; balanceDue: string; onlinePaymentsDisabled: boolean }): Promise<PublicOnlinePaymentDto | null> {
  if (inv.status !== 'issued' || inv.onlinePaymentsDisabled) return null;
  const conn = await liveConnection(s);
  if (!conn || conn.status !== 'active' || !conn.chargesEnabled) return null;
  const cur = s.company.baseCurrency;
  const processing = await processingAmountForInvoice(s, inv.id);
  const payable = Money.round(inv.balanceDue, cur).subtract(processing);
  const methods: PublicOnlinePaymentDto['methods'] = [];
  if (conn.allowCard) methods.push('card');
  if (conn.allowAch) methods.push('ach');
  return {
    methods,
    allowPartial: conn.allowPartial,
    minimumPayment: Money.round(conn.minimumPayment, cur).toString(),
    payableAmount: payable.max(Money.zero(cur)).toString(),
    processingAmount: processing.toString(),
  };
}

async function invoiceByPublicToken(tx: Parameters<Parameters<typeof withSystem>[1]>[0], token: string) {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  const hash = sha256Hex(token);
  const [inv] = await tx.select().from(schema.invoices).where(eq(schema.invoices.publicTokenHash, hash)).limit(1);
  if (!inv || inv.publicTokenRevokedAt || inv.status === 'draft') return null;
  return inv;
}

/**
 * Customer clicked Pay. Two transactions around one network call:
 *  1. validate and insert the charge row (pending) — the row id is the Stripe
 *     idempotency key, so a retried request cannot open two sessions;
 *  2. create the Checkout Session; 3. store the session/intent ids.
 * A crash after (2) leaves a pending row that the session's own webhooks
 * (completed/expired) reconcile by payment-intent id.
 */
export async function createPublicCheckout(
  db: Db,
  deps: ProcessorDeps,
  token: string,
  input: PublicCheckoutInput,
  urls: { successUrl: string; cancelUrl: string },
): Promise<{ url: string; chargeId: string }> {
  const feeConfig = deps.feeConfig ?? DEFAULT_PLATFORM_FEE;
  const prepared = await withDbErrors(() =>
    withSystem(db, async (tx) => {
      const inv = await invoiceByPublicToken(tx, token);
      if (!inv) throw notFound('Invoice');
      const ctx: CompanyContext = { companyId: inv.companyId, actorId: 'public:payer', actorType: 'system' };
      await tx.execute(sql`select set_config('app.company_id', ${inv.companyId}, true)`);
      const [company] = await tx.select().from(schema.companies).where(eq(schema.companies.id, inv.companyId));
      const s: ServiceContext = { tx, ctx, company: company! };
      const info = await publicOnlinePaymentInfo(s, inv);
      if (!info) throw new ServiceError('invalid_state', 'This invoice cannot be paid online');
      const cur = company!.baseCurrency;
      const payable = Money.of(info.payableAmount, cur);
      if (!payable.isPositive()) throw new ServiceError('invalid_state', 'Nothing is due on this invoice right now');
      const amount = input.amount ? Money.of(input.amount, cur) : payable;
      if (amount.gt(payable)) throw new ServiceError('validation', `The most you can pay now is ${payable.toString()}`);
      if (!info.allowPartial && !amount.equals(payable)) throw new ServiceError('validation', 'This invoice must be paid in full');
      const minimum = Money.of(info.minimumPayment, cur).min(payable);
      if (amount.lt(minimum)) throw new ServiceError('validation', `The minimum payment is ${minimum.toString()}`);
      const conn = (await liveConnection(s))!;
      if (!info.methods.includes(input.method)) throw new ServiceError('validation', `Paying by ${input.method === 'ach' ? 'bank debit' : 'card'} is not offered on this invoice`);
      // The all-in fee promise depends on the method, so one method per session.
      const platformFee = computePlatformFee(amount, company!.plan, input.method, feeConfig);
      const chargeId = randomUUID();
      await tx.insert(schema.processorCharges).values({
        id: chargeId,
        companyId: inv.companyId,
        connectionId: conn.id,
        provider: conn.provider,
        invoiceId: inv.id,
        contactId: inv.contactId,
        origin: 'evenbooks',
        status: 'pending',
        method: input.method,
        currency: cur,
        amount: amount.toString(),
        platformFee: platformFee.toString(),
        description: `Invoice ${inv.number}`,
        payerEmail: inv.customerSnapshot?.email ?? null,
        createdBy: ctx.actorId,
      });
      // Older open sessions for this invoice are superseded; expire them best-effort after commit.
      const stale = await tx
        .select({ id: schema.processorCharges.id, sessionId: schema.processorCharges.providerCheckoutSessionId })
        .from(schema.processorCharges)
        .where(and(eq(schema.processorCharges.companyId, inv.companyId), eq(schema.processorCharges.invoiceId, inv.id), eq(schema.processorCharges.status, 'pending'), sql`${schema.processorCharges.id} <> ${chargeId}`));
      const methods: ('card' | 'ach')[] = [input.method];
      return {
        chargeId,
        companyId: inv.companyId,
        accountId: conn.providerAccountId,
        amount: amount.toString(),
        currency: cur,
        methods,
        platformFee: platformFee.toString(),
        description: `${company!.name} — Invoice ${inv.number}`,
        customerEmail: inv.customerSnapshot?.email ?? null,
        invoiceId: inv.id,
        invoiceNumber: inv.number,
        stale: stale.filter((x) => x.sessionId),
      };
    }),
  );

  let session;
  try {
    session = await deps.client.createCheckoutSession({
      accountId: prepared.accountId,
      amount: prepared.amount,
      currency: prepared.currency,
      methods: prepared.methods,
      applicationFee: prepared.platformFee,
      description: prepared.description,
      customerEmail: prepared.customerEmail,
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      metadata: { evenbooks_charge_id: prepared.chargeId, evenbooks_invoice_id: prepared.invoiceId, evenbooks_company_id: prepared.companyId, invoice_number: prepared.invoiceNumber ?? '' },
      idempotencyKey: `checkout:${prepared.chargeId}`,
    });
  } catch (err) {
    await withSystem(db, async (tx) => {
      await tx.execute(sql`select set_config('app.company_id', ${prepared.companyId}, true)`);
      await tx.update(schema.processorCharges).set({ status: 'canceled', failureMessage: `Could not start checkout: ${(err as Error).message}` }).where(eq(schema.processorCharges.id, prepared.chargeId));
    }).catch(() => {});
    if (err instanceof PaymentProcessorError) throw new ServiceError('external_error', 'The payment provider could not start a checkout right now. Please try again shortly.', { kind: err.kind });
    throw err;
  }
  await withSystem(db, async (tx) => {
    await tx.execute(sql`select set_config('app.company_id', ${prepared.companyId}, true)`);
    await tx
      .update(schema.processorCharges)
      .set({ providerCheckoutSessionId: session.id, providerPaymentIntentId: session.paymentIntentId, expiresAt: session.expiresAt })
      .where(eq(schema.processorCharges.id, prepared.chargeId));
  });
  for (const st of prepared.stale) {
    await deps.client.expireCheckoutSession(prepared.accountId, st.sessionId!).catch(() => {});
  }
  return { url: session.url, chargeId: prepared.chargeId };
}

// ---------------------------------------------------------------------------
// Event ingestion
// ---------------------------------------------------------------------------
export type IngestOutcome = { status: 'duplicate' | 'processed' | 'ignored' | 'failed'; eventId: number | null; error?: string };

/**
 * Store first, then process in the connection's company. Duplicates (Stripe
 * retries) are recognised by the provider event id. Processing failures are
 * recorded on the event and retried by the worker; the delivery is still
 * acknowledged because we own the retry.
 */
export async function ingestProcessorEvent(db: Db, deps: ProcessorDeps, evt: ProcessorEvent): Promise<IngestOutcome> {
  const stored = await withSystem(db, async (tx) => {
    const conn = evt.accountId
      ? (await tx.select({ id: schema.paymentProcessorConnections.id, companyId: schema.paymentProcessorConnections.companyId }).from(schema.paymentProcessorConnections).where(and(eq(schema.paymentProcessorConnections.provider, deps.client.provider), eq(schema.paymentProcessorConnections.providerAccountId, evt.accountId))).limit(1))[0] ?? null
      : null;
    const [row] = await tx
      .insert(schema.processorEvents)
      .values({
        provider: deps.client.provider,
        providerEventId: evt.id,
        providerAccountId: evt.accountId,
        eventType: evt.type,
        payload: evt.raw,
        occurredAt: new Date(evt.createdAt * 1000).toISOString(),
        companyId: conn?.companyId ?? null,
        connectionId: conn?.id ?? null,
        processedAt: conn ? null : new Date().toISOString(),
        lastError: conn ? null : 'No connection for this account',
      })
      .onConflictDoNothing()
      .returning({ id: schema.processorEvents.id });
    return { row: row ?? null, conn };
  });
  if (!stored.row) return { status: 'duplicate', eventId: null };
  if (!stored.conn) return { status: 'ignored', eventId: stored.row.id };
  return processStoredEvent(db, deps, stored.row.id, stored.conn, evt);
}

async function processStoredEvent(db: Db, deps: ProcessorDeps, eventId: number, conn: { id: string; companyId: string }, evt: ProcessorEvent): Promise<IngestOutcome> {
  try {
    await runJobInCompany(db, { companyId: conn.companyId, actorId: PROCESSOR_ACTOR, actorType: 'system' }, async (s) => {
      await handleEvent(s, deps, conn.id, evt);
      await s.tx.update(schema.paymentProcessorConnections).set({ lastEventAt: new Date().toISOString() }).where(eq(schema.paymentProcessorConnections.id, conn.id));
    });
    await withSystem(db, (tx) => tx.update(schema.processorEvents).set({ processedAt: new Date().toISOString(), lastError: null, attempts: sql`${schema.processorEvents.attempts} + 1` }).where(eq(schema.processorEvents.id, eventId)));
    return { status: 'processed', eventId };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    await withSystem(db, (tx) => tx.update(schema.processorEvents).set({ lastError: message.slice(0, 2000), attempts: sql`${schema.processorEvents.attempts} + 1` }).where(eq(schema.processorEvents.id, eventId))).catch(() => {});
    return { status: 'failed', eventId, error: message };
  }
}

/** Worker: retry events whose processing failed (transient errors, ordering races). */
export async function retryProcessorEvents(db: Db, deps: ProcessorDeps, opts: { limit?: number; maxAttempts?: number; olderThanMs?: number } = {}): Promise<{ retried: number; processed: number }> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? 60_000)).toISOString();
  const rows = await withSystem(db, (tx) =>
    tx
      .select()
      .from(schema.processorEvents)
      .where(and(isNull(schema.processorEvents.processedAt), sql`${schema.processorEvents.connectionId} is not null`, lt(schema.processorEvents.attempts, opts.maxAttempts ?? 12), lt(schema.processorEvents.receivedAt, cutoff)))
      .orderBy(asc(schema.processorEvents.receivedAt))
      .limit(opts.limit ?? 50),
  );
  let processed = 0;
  for (const r of rows) {
    const evt: ProcessorEvent = { id: r.providerEventId, type: r.eventType, accountId: r.providerAccountId, createdAt: r.occurredAt ? Math.floor(Date.parse(r.occurredAt) / 1000) : Math.floor(Date.now() / 1000), object: ((r.payload.data as { object?: Record<string, unknown> } | undefined)?.object ?? {}) as Record<string, unknown>, livemode: Boolean(r.payload.livemode), raw: r.payload };
    const out = await processStoredEvent(db, deps, r.id, { id: r.connectionId!, companyId: r.companyId! }, evt);
    if (out.status === 'processed') processed++;
  }
  return { retried: rows.length, processed };
}

/**
 * Worker: post fees for charges that settled before Stripe attached the balance
 * transaction and whose charge.updated never arrived (or failed every retry).
 */
export async function settlePendingChargeFees(db: Db, deps: ProcessorDeps, opts: { limit?: number; olderThanMs?: number } = {}): Promise<{ checked: number; settled: number }> {
  const cutoff = new Date(Date.now() - (opts.olderThanMs ?? 120_000)).toISOString();
  const rows = await withSystem(db, (tx) =>
    tx
      .select({ id: schema.processorCharges.id, companyId: schema.processorCharges.companyId, connectionId: schema.processorCharges.connectionId })
      .from(schema.processorCharges)
      .where(and(eq(schema.processorCharges.status, 'succeeded'), isNull(schema.processorCharges.providerBalanceTransactionId), sql`${schema.processorCharges.providerPaymentIntentId} is not null`, lt(schema.processorCharges.succeededAt, cutoff)))
      .orderBy(asc(schema.processorCharges.succeededAt))
      .limit(opts.limit ?? 50),
  );
  let settled = 0;
  for (const r of rows) {
    try {
      const done = await runJobInCompany(db, { companyId: r.companyId, actorId: PROCESSOR_ACTOR, actorType: 'system' }, async (s) => {
        const conn = await loadConnection(s, r.connectionId);
        const charge = await chargeBy(s, { chargeId: r.id });
        return charge ? settleChargeFees(s, deps, conn, charge) : false;
      });
      if (done) settled++;
    } catch {
      // still not attached, or a transient error: the next run tries again
    }
  }
  return { checked: rows.length, settled };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

async function loadConnection(s: ServiceContext, id: string): Promise<ConnectionRow> {
  const [c] = await s.tx.select().from(schema.paymentProcessorConnections).where(and(eq(schema.paymentProcessorConnections.companyId, s.ctx.companyId), eq(schema.paymentProcessorConnections.id, id))).for('update');
  if (!c) throw notFound('Payment processor connection');
  return c;
}

async function chargeBy(s: ServiceContext, where: { sessionId?: string | null; paymentIntentId?: string | null; chargeId?: string | null }, forUpdate = true): Promise<ChargeRow | null> {
  const conds = [];
  if (where.sessionId) conds.push(eq(schema.processorCharges.providerCheckoutSessionId, where.sessionId));
  if (where.paymentIntentId) conds.push(eq(schema.processorCharges.providerPaymentIntentId, where.paymentIntentId));
  if (where.chargeId) conds.push(eq(schema.processorCharges.id, where.chargeId));
  if (conds.length === 0) return null;
  const q = s.tx
    .select()
    .from(schema.processorCharges)
    .where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), conds.length === 1 ? conds[0] : sql`(${sql.join(conds, sql` or `)})`))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

/** Accounting date for a provider timestamp; falls back to today when that day's period is closed. */
async function postingDate(s: ServiceContext, unixSeconds: number | null): Promise<{ date: string; deferred: boolean }> {
  const today = todayInTimeZone(s.company.timeZone);
  const wanted = unixSeconds ? todayInTimeZone(s.company.timeZone, new Date(unixSeconds * 1000)) : today;
  const r = await s.tx.execute<{ locked: boolean }>(sql`select app.is_date_locked(${s.ctx.companyId}::uuid, ${wanted}::date) as locked`);
  if (r.rows[0]?.locked) return { date: today, deferred: true };
  return { date: wanted, deferred: false };
}

async function handleEvent(s: ServiceContext, deps: ProcessorDeps, connectionId: string, evt: ProcessorEvent): Promise<void> {
  const conn = await loadConnection(s, connectionId);
  const o = evt.object;
  switch (evt.type) {
    case 'account.updated': {
      const flags = { chargesEnabled: Boolean(o.charges_enabled), payoutsEnabled: Boolean(o.payouts_enabled), detailsSubmitted: Boolean(o.details_submitted) };
      const reason = str((o.requirements as Record<string, unknown> | undefined)?.disabled_reason);
      await s.tx
        .update(schema.paymentProcessorConnections)
        .set({ ...flags, status: conn.status === 'disconnected' ? 'disconnected' : accountStatus(flags), displayName: str((o.business_profile as Record<string, unknown> | undefined)?.name) ?? conn.displayName, lastError: reason, lastErrorAt: reason ? new Date().toISOString() : null })
        .where(eq(schema.paymentProcessorConnections.id, conn.id));
      return;
    }
    case 'account.application.deauthorized': {
      // The business removed Evenbooks from its Stripe account; nothing can be charged or read any more.
      if (conn.status === 'disconnected') return;
      await s.tx
        .update(schema.paymentProcessorConnections)
        .set({ status: 'disconnected', disconnectedAt: new Date().toISOString(), lastError: 'Evenbooks was removed from this Stripe account', lastErrorAt: new Date().toISOString() })
        .where(eq(schema.paymentProcessorConnections.id, conn.id));
      await recordAudit(s, { action: 'processor.disconnected', entityType: 'processor_connection', entityId: conn.id, details: { reason: 'deauthorized_in_stripe' } });
      return;
    }
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const sessionId = str(o.id);
      const piId = str(o.payment_intent);
      let charge = await chargeBy(s, { sessionId, paymentIntentId: piId });
      if (!charge && piId) charge = await ensureExternalCharge(s, deps, conn, piId);
      if (!charge) return;
      if (charge.status === 'succeeded') return;
      if (o.payment_status === 'paid') {
        await settleCharge(s, deps, conn, charge, piId ?? charge.providerPaymentIntentId!);
      } else {
        await s.tx
          .update(schema.processorCharges)
          .set({ status: 'processing', providerPaymentIntentId: piId ?? charge.providerPaymentIntentId, payerEmail: str((o.customer_details as Record<string, unknown> | undefined)?.email) ?? charge.payerEmail })
          .where(eq(schema.processorCharges.id, charge.id));
      }
      return;
    }
    case 'checkout.session.async_payment_failed': {
      const charge = await chargeBy(s, { sessionId: str(o.id), paymentIntentId: str(o.payment_intent) });
      if (charge && charge.status !== 'succeeded') {
        await s.tx.update(schema.processorCharges).set({ status: 'failed', failureMessage: 'The bank debit failed' }).where(eq(schema.processorCharges.id, charge.id));
      }
      return;
    }
    case 'checkout.session.expired': {
      const charge = await chargeBy(s, { sessionId: str(o.id) });
      if (charge && charge.status === 'pending') {
        await s.tx.update(schema.processorCharges).set({ status: 'canceled', failureMessage: 'Checkout expired before payment' }).where(eq(schema.processorCharges.id, charge.id));
      }
      return;
    }
    case 'payment_intent.succeeded': {
      const piId = str(o.id);
      if (!piId) return;
      const meta = (o.metadata as Record<string, unknown> | undefined) ?? {};
      // Checkouts opened before the rename still carry the original metadata key.
      let charge = await chargeBy(s, { paymentIntentId: piId, chargeId: str(meta.evenbooks_charge_id) ?? str(meta.beans_charge_id) });
      if (!charge) charge = await ensureExternalCharge(s, deps, conn, piId);
      if (charge.status === 'succeeded') return;
      await settleCharge(s, deps, conn, charge, piId);
      return;
    }
    case 'charge.updated': {
      // Stripe announces the balance transaction (and so the fees) here.
      if (!str(o.balance_transaction)) return;
      const charge = await chargeBy(s, { paymentIntentId: str(o.payment_intent) });
      if (charge) await settleChargeFees(s, deps, conn, charge);
      return;
    }
    case 'payment_intent.payment_failed': {
      // Card declines inside an open Checkout session are retried by the customer; only a
      // processing (ACH) debit that fails is final.
      const charge = await chargeBy(s, { paymentIntentId: str(o.id) });
      if (charge && charge.status === 'processing') {
        const msg = str((o.last_payment_error as Record<string, unknown> | undefined)?.message) ?? 'Payment failed';
        await s.tx.update(schema.processorCharges).set({ status: 'failed', failureMessage: msg }).where(eq(schema.processorCharges.id, charge.id));
      }
      return;
    }
    case 'charge.refunded': {
      const piId = str(o.payment_intent);
      const charge = piId ? await chargeBy(s, { paymentIntentId: piId }) : null;
      if (!charge) return; // refund of a charge we never saw succeed; nothing in the books to reverse
      const list = ((o.refunds as { data?: Record<string, unknown>[] } | undefined)?.data ?? []) as Record<string, unknown>[];
      for (const r of list) {
        if (str(r.status) !== 'succeeded') continue;
        await applyProviderRefund(s, conn, charge, { id: str(r.id)!, amount: fromMinorUnits(num(r.amount) ?? 0, charge.currency), reason: str(r.reason), metadata: (r.metadata as Record<string, string> | undefined) ?? {}, createdAt: num(r.created) });
      }
      return;
    }
    case 'charge.dispute.created':
    case 'charge.dispute.funds_withdrawn': {
      const piId = str(o.payment_intent);
      const charge = piId ? await chargeBy(s, { paymentIntentId: piId }) : null;
      if (!charge || charge.status !== 'succeeded') return;
      const fee = ((o.balance_transactions as { fee?: number }[] | undefined) ?? []).reduce((acc, b) => acc + (b.fee ?? 0), 0);
      await openDispute(s, conn, charge, { id: str(o.id)!, amount: fromMinorUnits(num(o.amount) ?? 0, charge.currency), fee: fromMinorUnits(fee, charge.currency), reason: str(o.reason), status: str(o.status), createdAt: num(o.created) });
      return;
    }
    case 'charge.dispute.closed':
    case 'charge.dispute.funds_reinstated': {
      const piId = str(o.payment_intent);
      const charge = piId ? await chargeBy(s, { paymentIntentId: piId }) : null;
      if (!charge) return;
      const status = str(o.status);
      if (evt.type === 'charge.dispute.funds_reinstated' || status === 'won' || status === 'warning_closed') {
        await winDispute(s, conn, charge, { id: str(o.id)!, status: status ?? 'won', createdAt: num(o.created) });
      } else if (status) {
        await s.tx.update(schema.processorRefunds).set({ disputeStatus: status }).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.providerDisputeId, str(o.id)!), eq(schema.processorRefunds.kind, 'dispute')));
      }
      return;
    }
    case 'payout.created':
    case 'payout.updated':
    case 'payout.paid':
    case 'payout.failed':
    case 'payout.canceled': {
      await upsertPayout(s, conn, { id: str(o.id)!, amount: fromMinorUnits(num(o.amount) ?? 0, str(o.currency)?.toUpperCase() ?? s.company.baseCurrency), currency: str(o.currency)?.toUpperCase() ?? s.company.baseCurrency, status: str(o.status) as PayoutRow['status'], arrivalDate: num(o.arrival_date), description: str(o.description), failureMessage: str(o.failure_message) });
      return;
    }
    default:
      return; // unhandled event types are stored and marked processed
  }
}

function fromMinorUnits(minor: number, currency: string): string {
  const scale = Money.zero(currency).toString().split('.')[1]?.length ?? 2;
  const neg = minor < 0;
  const sAbs = String(Math.abs(minor)).padStart(scale + 1, '0');
  const int = sAbs.slice(0, sAbs.length - scale) || '0';
  const frac = scale ? '.' + sAbs.slice(sAbs.length - scale) : '';
  return `${neg ? '-' : ''}${int}${frac}`;
}

/** A charge on the connected account that Evenbooks did not originate (dashboard, payment link). */
async function ensureExternalCharge(s: ServiceContext, deps: ProcessorDeps, conn: ConnectionRow, piId: string): Promise<ChargeRow> {
  const existing = await chargeBy(s, { paymentIntentId: piId });
  if (existing) return existing;
  const pi = await deps.client.retrievePaymentIntent(conn.providerAccountId, piId);
  const [row] = await s.tx
    .insert(schema.processorCharges)
    .values({
      companyId: s.ctx.companyId,
      connectionId: conn.id,
      provider: conn.provider,
      providerPaymentIntentId: piId,
      origin: 'external',
      status: pi.status === 'succeeded' ? 'processing' : pi.status === 'processing' ? 'processing' : 'pending',
      currency: pi.currency,
      amount: pi.amount,
      description: pi.description ?? 'Payment received through Stripe',
      payerEmail: pi.payerEmail,
      method: pi.method,
      createdBy: s.ctx.actorId,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? (await chargeBy(s, { paymentIntentId: piId }))!;
}

/**
 * Money arrived in the Stripe balance. Post the customer payment (allocated to
 * the invoice when there is one) and the fee entry, then mark the charge.
 */
async function settleCharge(s: ServiceContext, deps: ProcessorDeps, conn: ConnectionRow, charge: ChargeRow, piId: string): Promise<void> {
  const pi = await deps.client.retrievePaymentIntent(conn.providerAccountId, piId);
  if (pi.status !== 'succeeded') {
    // The webhook said paid but the intent disagrees (ordering / test data); keep it processing and let retry sort it out.
    throw new ServiceError('invalid_state', `Payment intent ${piId} is ${pi.status}, not succeeded`);
  }
  const cur = s.company.baseCurrency;
  if (pi.currency !== cur) throw new ServiceError('validation', `Charge currency ${pi.currency} differs from company currency ${cur}`);
  const amount = Money.of(pi.amount, cur);
  const { date, deferred } = await postingDate(s, pi.createdAt);
  const method = pi.method === 'ach' ? 'ach' : pi.method === 'card' ? 'card' : 'other';

  let invoice = charge.invoiceId ? await loadInvoice(s, charge.invoiceId) : null;
  let contactId = charge.contactId ?? invoice?.contactId ?? null;
  const allocations: { invoiceId: string; amount: string }[] = [];
  if (invoice && invoice.status === 'issued') {
    const balance = Money.round(invoice.balanceDue, cur);
    const apply = amount.min(balance);
    if (apply.isPositive()) allocations.push({ invoiceId: invoice.id, amount: apply.toString() });
  } else {
    invoice = null;
  }
  const label = invoice ? `Stripe payment for invoice ${invoice.number}` : `Stripe payment${pi.description ? `: ${pi.description}` : ''}`;
  const payment = await createPayment(s, {
    contactId,
    date,
    amount: amount.toString(),
    method,
    reference: pi.paymentIntentId,
    memo: `${label}${deferred ? ' (posted on the first open date; original period is closed)' : ''}`,
    depositAccountId: conn.clearingAccountId,
    isRefundableDeposit: false,
    allocations,
    idempotencyKey: `processor:charge:${charge.id}`,
  });
  contactId = payment.contactId;

  // Live Stripe attaches the balance transaction (and so the fees) a few seconds
  // after the charge succeeds. Until then the fees are unknown, not zero: post the
  // payment now and let charge.updated (or the worker sweep) post the fees.
  const feesKnown = pi.balanceTransactionId != null;
  const processorFee = feesKnown ? Money.of(pi.processorFee, cur) : Money.zero(cur);
  const platformFee = feesKnown ? Money.of(pi.applicationFee, cur) : Money.zero(cur);
  const feeEntryId = feesKnown ? await postChargeFees(s, conn, charge.id, pi.paymentIntentId, { processorFee, platformFee, date, label, contactId }) : null;
  await s.tx
    .update(schema.processorCharges)
    .set({
      status: 'succeeded',
      providerPaymentIntentId: pi.paymentIntentId,
      providerChargeId: pi.chargeId,
      providerBalanceTransactionId: pi.balanceTransactionId,
      method: pi.method,
      amount: amount.toString(),
      processorFee: processorFee.toString(),
      platformFee: platformFee.toString(),
      paymentId: payment.id,
      feeJournalEntryId: feeEntryId,
      payerEmail: pi.payerEmail ?? charge.payerEmail,
      contactId,
      succeededAt: new Date(pi.createdAt * 1000).toISOString(),
      failureMessage: null,
    })
    .where(eq(schema.processorCharges.id, charge.id));
  await recordAudit(s, { action: 'processor.charge_settled', entityType: 'processor_charge', entityId: charge.id, details: { paymentId: payment.id, amount: amount.toString(), processorFee: processorFee.toString(), platformFee: platformFee.toString(), invoiceId: invoice?.id ?? null, origin: charge.origin } });
}

/** The fee entry for a settled charge: Stripe's fee and ours, out of the clearing account. Idempotent per charge. */
async function postChargeFees(
  s: ServiceContext,
  conn: ConnectionRow,
  chargeId: string,
  paymentIntentId: string,
  f: { processorFee: Money; platformFee: Money; date: string; label: string; contactId: string | null },
): Promise<string | null> {
  const total = f.processorFee.add(f.platformFee);
  if (!total.isPositive()) return null;
  const lines: EntryLineInput[] = [];
  if (f.processorFee.isPositive()) lines.push({ accountId: conn.feeAccountId, debit: f.processorFee, memo: 'Stripe processing fee', contactId: f.contactId });
  if (f.platformFee.isPositive()) lines.push({ accountId: conn.feeAccountId, debit: f.platformFee, memo: 'Evenbooks platform fee', contactId: f.contactId });
  lines.push({ accountId: conn.clearingAccountId, credit: total, memo: `Fees on ${paymentIntentId}`, contactId: f.contactId });
  const entry = await postEntry(s, { date: f.date, memo: `Processing fees on ${f.label}`, sourceType: 'processor_fee', sourceId: chargeId, cashTreatment: 'include', lines, idempotencyKey: `processor:fee:${chargeId}` });
  return entry.id;
}

/**
 * A charge that settled before Stripe attached its balance transaction: fetch the
 * fees now and post them. Throws while Stripe still has not attached them, so the
 * event (or the sweep) tries again later.
 */
async function settleChargeFees(s: ServiceContext, deps: ProcessorDeps, conn: ConnectionRow, charge: ChargeRow): Promise<boolean> {
  if (charge.status !== 'succeeded' || charge.providerBalanceTransactionId || !charge.providerPaymentIntentId) return false;
  const pi = await deps.client.retrievePaymentIntent(conn.providerAccountId, charge.providerPaymentIntentId);
  if (!pi.balanceTransactionId) throw new ServiceError('invalid_state', `Stripe has not attached the fees to ${pi.paymentIntentId} yet`);
  const cur = s.company.baseCurrency;
  const processorFee = Money.of(pi.processorFee, cur);
  const platformFee = Money.of(pi.applicationFee, cur);
  const invoice = charge.invoiceId ? await loadInvoice(s, charge.invoiceId) : null;
  const label = invoice ? `Stripe payment for invoice ${invoice.number}` : `Stripe payment${pi.description ? `: ${pi.description}` : ''}`;
  const { date } = await postingDate(s, pi.createdAt);
  const feeEntryId = await postChargeFees(s, conn, charge.id, pi.paymentIntentId, { processorFee, platformFee, date, label, contactId: charge.contactId });
  await s.tx
    .update(schema.processorCharges)
    .set({ providerBalanceTransactionId: pi.balanceTransactionId, processorFee: processorFee.toString(), platformFee: platformFee.toString(), feeJournalEntryId: feeEntryId })
    .where(eq(schema.processorCharges.id, charge.id));
  await recordAudit(s, { action: 'processor.charge_fees_settled', entityType: 'processor_charge', entityId: charge.id, details: { processorFee: processorFee.toString(), platformFee: platformFee.toString() } });
  return true;
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
/**
 * Books for money going back to the payer from the Stripe balance: free enough
 * of the payment by reversing allocations (newest first), refund from the
 * clearing account, then re-apply any leftover to the invoice so only the
 * refunded portion reopens.
 */
async function refundPaymentToBooks(s: ServiceContext, conn: ConnectionRow, charge: ChargeRow, amount: Money, date: string, reference: string, memo: string, idem: string): Promise<{ refundId: string; paymentId: string }> {
  if (!charge.paymentId) throw new ServiceError('invalid_state', 'The charge has no payment in the books yet');
  const cur = s.company.baseCurrency;
  let payment = await getPayment(s, charge.paymentId);
  if (payment.status !== 'posted') throw new ServiceError('invalid_state', 'The payment is void');
  let unapplied = Money.of(payment.unappliedAmount, cur);
  const reopened: { invoiceId: string }[] = [];
  const active = (payment.allocations ?? []).filter((a) => a.status === 'active').sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const a of active) {
    if (unapplied.gte(amount)) break;
    payment = await reverseAllocation(s, a.id, { reason: `Online refund ${reference}`, date, idempotencyKey: `${idem}:unapply:${a.id}` });
    unapplied = Money.of(payment.unappliedAmount, cur);
    reopened.push({ invoiceId: a.invoiceId });
  }
  if (unapplied.lt(amount)) throw new ServiceError('over_allocation', `Only ${unapplied.toString()} of the payment can be refunded`);
  const method = payment.method === 'ach' || payment.method === 'card' ? payment.method : 'other';
  const refund = await createRefund(s, { sourceType: 'payment', sourceId: payment.id, date, amount: amount.toString(), fromAccountId: conn.clearingAccountId, method, reference, memo, idempotencyKey: `${idem}:refund` });
  const leftover = unapplied.subtract(amount);
  if (leftover.isPositive() && reopened.length > 0) {
    const inv = await loadInvoice(s, reopened[0]!.invoiceId);
    if (inv.status === 'issued') {
      const apply = leftover.min(Money.round(inv.balanceDue, cur));
      if (apply.isPositive()) {
        payment = await getPayment(s, payment.id);
        await allocatePayment(s, payment.id, { version: payment.version, date, allocations: [{ invoiceId: inv.id, amount: apply.toString() }], idempotencyKey: `${idem}:reapply` });
      }
    }
  }
  return { refundId: refund.id, paymentId: payment.id };
}

/** A refund reported by the provider (ours or from the dashboard): make sure the books show it exactly once. */
async function applyProviderRefund(s: ServiceContext, conn: ConnectionRow, charge: ChargeRow, r: { id: string; amount: string; reason: string | null; metadata: Record<string, string>; createdAt: number | null }): Promise<void> {
  const cur = s.company.baseCurrency;
  const [known] = await s.tx.select().from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.providerRefundId, r.id))).for('update');
  let row: RefundRow | null = known ?? null;
  // A provider webhook can arrive after an older refund request lost its response.
  const legacyRefundId = r.metadata.evenbooks_refund_id ?? r.metadata.beans_refund_id;
  if (!row && legacyRefundId) {
    const [ours] = await s.tx.select().from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.id, legacyRefundId))).for('update');
    row = ours ?? null;
  }
  if (row?.status === 'succeeded' && row.refundId) return; // already in the books
  const amount = Money.of(r.amount, cur);
  const { date } = await postingDate(s, r.createdAt);
  if (!row) {
    const [created] = await s.tx
      .insert(schema.processorRefunds)
      .values({ companyId: s.ctx.companyId, chargeId: charge.id, provider: conn.provider, providerRefundId: r.id, kind: 'refund', origin: 'external', status: 'pending', amount: amount.toString(), reason: r.reason, requestedBy: s.ctx.actorId })
      .returning();
    row = created!;
  }
  const { refundId, paymentId } = await refundPaymentToBooks(s, conn, charge, amount, date, r.id, `Stripe refund ${r.id}${r.reason ? ` (${r.reason})` : ''}`, `processor:refund:${row.id}`);
  // Our share returned with the refund goes back into the business's Stripe
  // balance, so the clearing account keeps matching Stripe.
  const feeReturned = Money.round(row.platformFeeRefunded, cur);
  let feeEntryId: string | null = row.feeJournalEntryId ?? null;
  if (feeReturned.isPositive() && !feeEntryId) {
    const entry = await postEntry(s, {
      date,
      memo: `Evenbooks platform fee returned with refund ${r.id}`,
      sourceType: 'processor_fee',
      sourceId: row.id,
      cashTreatment: 'include',
      lines: [
        { accountId: conn.clearingAccountId, debit: feeReturned, memo: 'Platform fee returned', contactId: charge.contactId },
        { accountId: conn.feeAccountId, credit: feeReturned, memo: 'Evenbooks platform fee returned', contactId: charge.contactId },
      ],
      idempotencyKey: `processor:fee-refund:${row.id}`,
    });
    feeEntryId = entry.id;
  }
  await s.tx
    .update(schema.processorRefunds)
    .set({ status: 'succeeded', providerRefundId: r.id, refundId, paymentId, feeJournalEntryId: feeEntryId, failureMessage: null })
    .where(eq(schema.processorRefunds.id, row.id));
  await s.tx
    .update(schema.processorCharges)
    .set({ amountRefunded: Money.round(charge.amountRefunded, cur).add(amount).toString(), platformFeeRefunded: Money.round(charge.platformFeeRefunded, cur).add(Money.round(row.platformFeeRefunded, cur)).toString() })
    .where(eq(schema.processorCharges.id, charge.id));
  await recordAudit(s, { action: 'processor.refund_recorded', entityType: 'processor_charge', entityId: charge.id, details: { providerRefundId: r.id, amount: amount.toString(), origin: row.origin, refundId } });
}

/**
 * Refund an online payment from Evenbooks. Network call between two transactions:
 * the pending row's id is the provider idempotency key, and the `charge.refunded`
 * webhook heals a crash between the call and the posting.
 */
export async function refundProcessorCharge(db: Db, deps: ProcessorDeps, ctx: CompanyContext, chargeId: string, input: RefundProcessorChargeInput): Promise<ProcessorRefundDto> {
  const prepared = await runInCompany(db, ctx, async (s) => {
    const cur = s.company.baseCurrency;
    const [charge] = await s.tx.select().from(schema.processorCharges).where(and(eq(schema.processorCharges.companyId, s.ctx.companyId), eq(schema.processorCharges.id, chargeId))).for('update');
    if (!charge) throw notFound('Online payment');
    if (charge.version !== input.version) throw versionConflict('Online payment');
    if (charge.status !== 'succeeded' || !charge.providerPaymentIntentId) throw new ServiceError('invalid_state', 'Only settled online payments can be refunded');
    // Until Stripe attaches the fees our share is unknown, and the proportional
    // fee refund would be computed from zero. This lasts seconds.
    if (!charge.providerBalanceTransactionId) throw new ServiceError('invalid_state', 'Stripe is still finalizing the fees on this payment. Try the refund again in a minute.');
    const amount = Money.of(input.amount, cur);
    const refundable = Money.round(charge.amount, cur).subtract(Money.round(charge.amountRefunded, cur)).subtract(Money.round(charge.amountDisputed, cur));
    const pending = await s.tx.select({ amount: schema.processorRefunds.amount }).from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.chargeId, charge.id), eq(schema.processorRefunds.status, 'pending')));
    const inFlight = Money.sum(pending.map((p) => Money.round(p.amount, cur)), cur);
    if (amount.gt(refundable.subtract(inFlight))) throw new ServiceError('over_allocation', `Only ${refundable.subtract(inFlight).toString()} can still be refunded`);
    // Evenbooks gives back its fee proportionally so the company is never out of pocket for our cut.
    const feeRefund = proportionalFeeRefund(Money.round(charge.platformFee, cur), Money.round(charge.amount, cur), amount, Money.round(charge.platformFeeRefunded, cur));
    const [row] = await s.tx
      .insert(schema.processorRefunds)
      .values({ companyId: s.ctx.companyId, chargeId: charge.id, provider: charge.provider, kind: 'refund', origin: 'evenbooks', status: 'pending', amount: amount.toString(), platformFeeRefunded: feeRefund.toString(), reason: input.reason, requestedBy: s.ctx.actorId })
      .returning();
    const conn = await loadConnection(s, charge.connectionId);
    await recordAudit(s, { action: 'processor.refund_requested', entityType: 'processor_charge', entityId: charge.id, reason: input.reason, details: { amount: amount.toString(), refundRowId: row!.id } });
    return { row: row!, charge, accountId: conn.providerAccountId, cur };
  });

  let provider;
  try {
    provider = await deps.client.createRefund({
      accountId: prepared.accountId,
      paymentIntentId: prepared.charge.providerPaymentIntentId!,
      amount: prepared.row.amount,
      currency: prepared.cur,
      applicationFeeRefund: prepared.row.platformFeeRefunded,
      reason: 'requested_by_customer',
      metadata: { evenbooks_refund_id: prepared.row.id, evenbooks_charge_id: prepared.charge.id },
      idempotencyKey: `refund:${prepared.row.id}`,
    });
  } catch (err) {
    await runInCompany(db, ctx, (s) => s.tx.update(schema.processorRefunds).set({ status: 'failed', failureMessage: (err as Error).message.slice(0, 1000) }).where(eq(schema.processorRefunds.id, prepared.row.id))).catch(() => {});
    if (err instanceof PaymentProcessorError) throw new ServiceError('external_error', `Stripe did not accept the refund: ${err.message}`, { kind: err.kind });
    throw err;
  }

  return runInCompany(db, ctx, async (s) => {
    const [charge] = await s.tx.select().from(schema.processorCharges).where(eq(schema.processorCharges.id, prepared.charge.id)).for('update');
    const conn = await loadConnection(s, charge!.connectionId);
    if (provider.status === 'succeeded' || provider.status === 'pending') {
      await applyProviderRefund(s, conn, charge!, { id: provider.id, amount: provider.amount, reason: provider.reason, metadata: { evenbooks_refund_id: prepared.row.id }, createdAt: provider.createdAt });
    } else {
      await s.tx.update(schema.processorRefunds).set({ status: 'failed', providerRefundId: provider.id, failureMessage: provider.failureReason ?? `Refund ${provider.status}` }).where(eq(schema.processorRefunds.id, prepared.row.id));
    }
    const [row] = await s.tx.select().from(schema.processorRefunds).where(eq(schema.processorRefunds.id, prepared.row.id));
    return toRefundDto(row!, s.company.baseCurrency);
  });
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------
async function openDispute(s: ServiceContext, conn: ConnectionRow, charge: ChargeRow, d: { id: string; amount: string; fee: string; reason: string | null; status: string | null; createdAt: number | null }): Promise<void> {
  const cur = s.company.baseCurrency;
  const [known] = await s.tx.select().from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.providerDisputeId, d.id), eq(schema.processorRefunds.kind, 'dispute'))).for('update');
  if (known?.status === 'succeeded') return;
  const amount = Money.of(d.amount, cur);
  const fee = Money.of(d.fee, cur);
  const { date } = await postingDate(s, d.createdAt);
  let row = known ?? null;
  if (!row) {
    const [created] = await s.tx
      .insert(schema.processorRefunds)
      .values({ companyId: s.ctx.companyId, chargeId: charge.id, provider: conn.provider, providerDisputeId: d.id, kind: 'dispute', origin: 'external', status: 'pending', amount: amount.toString(), feeAmount: fee.toString(), reason: d.reason, disputeStatus: d.status, requestedBy: s.ctx.actorId })
      .returning();
    row = created!;
  }
  const { refundId, paymentId } = await refundPaymentToBooks(s, conn, charge, amount, date, d.id, `Disputed by the customer (${d.reason ?? 'no reason given'}); funds withheld by Stripe`, `processor:dispute:${row.id}`);
  let feeEntryId: string | null = null;
  if (fee.isPositive()) {
    const entry = await postEntry(s, {
      date,
      memo: `Dispute fee ${d.id}`,
      sourceType: 'processor_fee',
      sourceId: row.id,
      cashTreatment: 'include',
      lines: [
        { accountId: conn.feeAccountId, debit: fee, memo: 'Stripe dispute fee' },
        { accountId: conn.clearingAccountId, credit: fee },
      ],
      idempotencyKey: `processor:dispute-fee:${row.id}`,
    });
    feeEntryId = entry.id;
  }
  await s.tx.update(schema.processorRefunds).set({ status: 'succeeded', refundId, paymentId, feeJournalEntryId: feeEntryId, disputeStatus: d.status }).where(eq(schema.processorRefunds.id, row.id));
  await s.tx.update(schema.processorCharges).set({ amountDisputed: Money.round(charge.amountDisputed, cur).add(amount).toString() }).where(eq(schema.processorCharges.id, charge.id));
  await recordAudit(s, { action: 'processor.dispute_opened', entityType: 'processor_charge', entityId: charge.id, details: { disputeId: d.id, amount: amount.toString(), fee: fee.toString(), reason: d.reason } });
}

/** Dispute won: Stripe returns the funds and the fee. Re-collect the payment and reverse the fee. */
async function winDispute(s: ServiceContext, conn: ConnectionRow, charge: ChargeRow, d: { id: string; status: string; createdAt: number | null }): Promise<void> {
  const cur = s.company.baseCurrency;
  const [dispute] = await s.tx.select().from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.providerDisputeId, d.id), eq(schema.processorRefunds.kind, 'dispute'))).for('update');
  if (!dispute || dispute.status !== 'succeeded') return;
  const [existing] = await s.tx.select().from(schema.processorRefunds).where(and(eq(schema.processorRefunds.companyId, s.ctx.companyId), eq(schema.processorRefunds.providerDisputeId, d.id), eq(schema.processorRefunds.kind, 'dispute_reversal')));
  if (existing) return;
  const amount = Money.round(dispute.amount, cur);
  const { date } = await postingDate(s, d.createdAt);
  const [row] = await s.tx
    .insert(schema.processorRefunds)
    .values({ companyId: s.ctx.companyId, chargeId: charge.id, provider: conn.provider, providerDisputeId: d.id, kind: 'dispute_reversal', origin: 'external', status: 'pending', amount: amount.toString(), feeAmount: dispute.feeAmount, disputeStatus: d.status, requestedBy: s.ctx.actorId })
    .returning();
  const invoice = charge.invoiceId ? await loadInvoice(s, charge.invoiceId) : null;
  const allocations: { invoiceId: string; amount: string }[] = [];
  if (invoice && invoice.status === 'issued') {
    const apply = amount.min(Money.round(invoice.balanceDue, cur));
    if (apply.isPositive()) allocations.push({ invoiceId: invoice.id, amount: apply.toString() });
  }
  const payment = await createPayment(s, {
    contactId: charge.contactId ?? invoice?.contactId ?? null,
    date,
    amount: amount.toString(),
    method: charge.method === 'ach' ? 'ach' : charge.method === 'card' ? 'card' : 'other',
    reference: d.id,
    memo: `Dispute ${d.id} won; funds reinstated by Stripe`,
    depositAccountId: conn.clearingAccountId,
    isRefundableDeposit: false,
    allocations,
    idempotencyKey: `processor:dispute-win:${row!.id}`,
  });
  let feeEntryId: string | null = null;
  if (dispute.feeJournalEntryId) {
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, dispute.feeJournalEntryId)).orderBy(asc(schema.journalLines.lineNo));
    const entry = await postEntry(s, {
      date,
      memo: `Dispute fee returned ${d.id}`,
      sourceType: 'processor_fee',
      sourceId: row!.id,
      cashTreatment: 'include',
      lines: reverseLines(lines.map((l) => ({ accountId: l.accountId, debit: Money.round(l.debit, cur), credit: Money.round(l.credit, cur), memo: l.memo, contactId: l.contactId }))),
      reversesEntryId: dispute.feeJournalEntryId,
      idempotencyKey: `processor:dispute-fee-reversal:${row!.id}`,
    });
    feeEntryId = entry.id;
  }
  await s.tx.update(schema.processorRefunds).set({ status: 'succeeded', paymentId: payment.id, feeJournalEntryId: feeEntryId }).where(eq(schema.processorRefunds.id, row!.id));
  await s.tx.update(schema.processorRefunds).set({ disputeStatus: d.status }).where(eq(schema.processorRefunds.id, dispute.id));
  await s.tx.update(schema.processorCharges).set({ amountDisputed: Money.round(charge.amountDisputed, cur).subtract(amount).max(Money.zero(cur)).toString() }).where(eq(schema.processorCharges.id, charge.id));
  await recordAudit(s, { action: 'processor.dispute_won', entityType: 'processor_charge', entityId: charge.id, details: { disputeId: d.id, paymentId: payment.id, amount: amount.toString() } });
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------
async function upsertPayout(s: ServiceContext, conn: ConnectionRow, p: { id: string; amount: string; currency: string; status: PayoutRow['status']; arrivalDate: number | null; description: string | null; failureMessage: string | null }): Promise<void> {
  const cur = s.company.baseCurrency;
  const arrival = p.arrivalDate ? new Date(p.arrivalDate * 1000).toISOString().slice(0, 10) : todayInTimeZone(s.company.timeZone);
  const status: PayoutRow['status'] = ['pending', 'in_transit', 'paid', 'failed', 'canceled'].includes(p.status) ? p.status : 'pending';
  const [existing] = await s.tx.select().from(schema.processorPayouts).where(and(eq(schema.processorPayouts.companyId, s.ctx.companyId), eq(schema.processorPayouts.providerPayoutId, p.id))).for('update');
  let row: PayoutRow;
  if (existing) {
    const [u] = await s.tx.update(schema.processorPayouts).set({ status, arrivalDate: arrival, description: p.description ?? existing.description, failureMessage: p.failureMessage }).where(eq(schema.processorPayouts.id, existing.id)).returning();
    row = u!;
  } else {
    const [c] = await s.tx
      .insert(schema.processorPayouts)
      .values({ companyId: s.ctx.companyId, connectionId: conn.id, provider: conn.provider, providerPayoutId: p.id, status, currency: p.currency, amount: p.amount, arrivalDate: arrival, description: p.description, failureMessage: p.failureMessage })
      .returning();
    row = c!;
  }
  const amount = Money.of(row.amount, cur);
  if (row.status === 'paid' && !row.journalEntryId && conn.autoPostPayouts && conn.payoutBankAccountId) {
    const bank = await getBankAccount(s, conn.payoutBankAccountId);
    const { date } = await postingDate(s, p.arrivalDate);
    // Positive payout: Dr bank / Cr clearing. Negative (Stripe debits the bank to cover a negative balance): the reverse.
    const lines: EntryLineInput[] = amount.isPositive()
      ? [
          { accountId: bank.ledgerAccountId, debit: amount, memo: `Stripe payout ${p.id}` },
          { accountId: conn.clearingAccountId, credit: amount, memo: `Stripe payout ${p.id}` },
        ]
      : [
          { accountId: conn.clearingAccountId, debit: amount.abs(), memo: `Stripe debit ${p.id}` },
          { accountId: bank.ledgerAccountId, credit: amount.abs(), memo: `Stripe debit ${p.id}` },
        ];
    const entry = await postEntry(s, { date, memo: `Stripe payout ${p.id}${p.description ? ` (${p.description})` : ''}`, sourceType: 'processor_payout', sourceId: row.id, cashTreatment: 'exclude', lines, idempotencyKey: `processor:payout:${row.id}` });
    await s.tx.update(schema.processorPayouts).set({ journalEntryId: entry.id, bankAccountId: bank.id }).where(eq(schema.processorPayouts.id, row.id));
    await recordAudit(s, { action: 'processor.payout_posted', entityType: 'processor_payout', entityId: row.id, details: { providerPayoutId: p.id, amount: amount.toString(), entryId: entry.id, bankAccountId: bank.id } });
  } else if ((row.status === 'failed' || row.status === 'canceled') && row.journalEntryId && !row.reversalEntryId) {
    const lines = await s.tx.select().from(schema.journalLines).where(eq(schema.journalLines.entryId, row.journalEntryId)).orderBy(asc(schema.journalLines.lineNo));
    const { date } = await postingDate(s, null);
    const entry = await postEntry(s, {
      date,
      memo: `Stripe payout ${p.id} ${row.status}${p.failureMessage ? `: ${p.failureMessage}` : ''}`,
      sourceType: 'processor_payout',
      sourceId: row.id,
      cashTreatment: 'exclude',
      lines: reverseLines(lines.map((l) => ({ accountId: l.accountId, debit: Money.round(l.debit, cur), credit: Money.round(l.credit, cur), memo: l.memo, contactId: l.contactId }))),
      reversesEntryId: row.journalEntryId,
      idempotencyKey: `processor:payout-reversal:${row.id}`,
    });
    await s.tx.update(schema.journalEntries).set({ reversedByEntryId: entry.id }).where(eq(schema.journalEntries.id, row.journalEntryId));
    await s.tx.update(schema.processorPayouts).set({ reversalEntryId: entry.id }).where(eq(schema.processorPayouts.id, row.id));
    await recordAudit(s, { action: 'processor.payout_reversed', entityType: 'processor_payout', entityId: row.id, details: { providerPayoutId: p.id, reversalEntryId: entry.id, status: row.status } });
  }
}

/** Posted payout for bank matching (inbox). */
export async function loadProcessorPayout(s: ServiceContext, id: string): Promise<PayoutRow> {
  const [row] = await s.tx.select().from(schema.processorPayouts).where(and(eq(schema.processorPayouts.companyId, s.ctx.companyId), eq(schema.processorPayouts.id, id))).limit(1);
  if (!row) throw notFound('Payout');
  return row;
}

