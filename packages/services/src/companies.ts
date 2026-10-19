import { getInvoicePresentation, updateInvoicePresentation } from './invoice-presentation';
import { eq, and, sql } from 'drizzle-orm';
import { withSystem, schema, type Db, type Tx } from '@evenbooks/db';
import { isValidTimeZone } from '@evenbooks/domain';
import type { CompanyDto, UpdateCompanyInput } from '@evenbooks/contracts';
import { DEFAULT_CHART } from './chart-of-accounts';
import { ServiceError, notFound, versionConflict, withDbErrors, unwrapDbError } from './errors';
import type { CompanyRow, ServiceContext } from './context';
import { recordAudit } from './audit';

export function toCompanyDto(c: CompanyRow): CompanyDto {
  return {
    id: c.id,
    clerkOrgId: c.clerkOrgId,
    name: c.name,
    legalName: c.legalName,
    email: c.email,
    phone: c.phone,
    address: c.address,
    baseCurrency: c.baseCurrency,
    timeZone: c.timeZone,
    fiscalYearStartMonth: c.fiscalYearStartMonth,
    invoicePrefix: c.invoicePrefix,
    nextInvoiceNumber: c.nextInvoiceNumber,
    creditNotePrefix: c.creditNotePrefix,
    defaultTermsDays: c.defaultTermsDays,
    invoiceFooter: c.invoiceFooter,
    hasPostedEntries: c.hasPostedEntries,
    plan: c.plan,
    transactionDeletionEnabled: c.transactionDeletionEnabled,
    businessType: c.businessType ?? null,
    taxBasis: c.taxBasis ?? null,
    booksStartDate: c.booksStartDate ?? null,
    setupDismissedAt: c.setupDismissedAt ?? null,
    version: c.version,
  };
}

export interface ProvisionInput {
  clerkOrgId: string;
  name: string;
  timeZone?: string;
  actorId: string;
  /** Billing plan as the identity provider (Clerk) reports it; synced into `companies.plan` when known. */
  plan?: 'free' | 'paid' | null;
}

/**
 * Find the company for a Clerk organization, provisioning it (with the default
 * chart of accounts) on first access. Idempotent under concurrency thanks to
 * the unique clerk_org_id: a losing racer re-reads the winner's row.
 */
export async function resolveCompanyForOrg(db: Db, input: ProvisionInput): Promise<CompanyRow> {
  return (await resolveCompanyForOrgDetailed(db, input)).company;
}

export interface ResolvedCompany {
  company: CompanyRow;
  /** The company was provisioned by this call. */
  created: boolean;
  /** `companies.plan` was updated by this call to match the identity provider. */
  planChanged: boolean;
}

/** Same as `resolveCompanyForOrg`, also reporting what changed so callers can push side effects (e.g. membership limits) to the identity provider. */
export async function resolveCompanyForOrgDetailed(db: Db, input: ProvisionInput): Promise<ResolvedCompany> {
  return withDbErrors(() =>
    withSystem(db, async (tx) => {
      const existing = await findByOrg(tx, input.clerkOrgId);
      if (existing) {
        const synced = await syncPlan(tx, existing, input.plan);
        return { company: synced.row, created: false, planChanged: synced.changed };
      }
      try {
        const synced = await syncPlan(tx, await provisionCompany(tx, input), input.plan);
        return { company: synced.row, created: true, planChanged: synced.changed };
      } catch (err) {
        // Concurrent first requests for a new organization race here (layout,
        // page and API calls all resolve the company). The loser sees a unique
        // violation, possibly wrapped by the driver, and must re-read the row.
        if (unwrapDbError(err)?.code === '23505') {
          const again = await findByOrg(tx, input.clerkOrgId);
          if (again) return { company: again, created: false, planChanged: false };
        }
        throw err;
      }
    }),
  );
}

/** Clerk is the billing authority; the column is a cache so webhooks and public checkout can read the plan without a session. */
async function syncPlan(tx: Tx, company: CompanyRow, plan: 'free' | 'paid' | null | undefined): Promise<{ row: CompanyRow; changed: boolean }> {
  if (!plan || plan === company.plan) return { row: company, changed: false };
  await tx.execute(sql`select set_config('app.company_id', ${company.id}, true)`);
  const [row] = await tx.update(schema.companies).set({ plan }).where(eq(schema.companies.id, company.id)).returning();
  await tx.insert(schema.auditEvents).values({ companyId: company.id, actorType: 'system', actorId: 'clerk', action: 'company.plan_changed', entityType: 'company', entityId: company.id, details: { from: company.plan, to: plan } });
  return { row: row ?? company, changed: true };
}

async function findByOrg(tx: Tx, clerkOrgId: string): Promise<CompanyRow | null> {
  const [row] = await tx.select().from(schema.companies).where(eq(schema.companies.clerkOrgId, clerkOrgId)).limit(1);
  return row ?? null;
}

async function provisionCompany(tx: Tx, input: ProvisionInput): Promise<CompanyRow> {
  // Use a savepoint so a unique violation does not poison the outer transaction.
  return tx.transaction(async (inner) => {
    const [company] = await inner
      .insert(schema.companies)
      .values({
        clerkOrgId: input.clerkOrgId,
        name: input.name,
        timeZone: input.timeZone && isValidTimeZone(input.timeZone) ? input.timeZone : 'America/New_York',
      })
      .returning();
    if (!company) throw new ServiceError('internal', 'Failed to create company');
    // Company-scoped writes need the company context in addition to system.
    await inner.execute(sql`select set_config('app.company_id', ${company.id}, true)`);
    await inner.insert(schema.accounts).values(
      DEFAULT_CHART.map((a) => ({
        companyId: company.id,
        code: a.code,
        name: a.name,
        type: a.type,
        role: a.role ?? null,
        isSystem: a.system ?? false,
        description: a.description ?? null,
        currency: company.baseCurrency,
      })),
    );
    // Default Schedule C mapping for the current tax year
    const year = new Date().getUTCFullYear();
    const accts = await inner.select().from(schema.accounts).where(eq(schema.accounts.companyId, company.id));
    const byCode = new Map(accts.map((a) => [a.code, a]));
    const mappings = DEFAULT_CHART.filter((a) => a.scheduleC)
      .map((a) => ({ companyId: company.id, taxYear: year, accountId: byCode.get(a.code)!.id, lineCode: a.scheduleC! }));
    if (mappings.length) await inner.insert(schema.taxFormMappings).values(mappings);
    await inner.insert(schema.auditEvents).values({
      companyId: company.id,
      actorType: 'user',
      actorId: input.actorId,
      action: 'company.provisioned',
      entityType: 'company',
      entityId: company.id,
      details: { clerkOrgId: input.clerkOrgId, name: input.name },
    });
    return company;
  });
}

export async function updateCompany(s: ServiceContext, input: UpdateCompanyInput): Promise<CompanyDto> {
  if (input.timeZone && !isValidTimeZone(input.timeZone)) {
    throw new ServiceError('validation', `Unknown time zone ${input.timeZone}`);
  }
  if (input.nextInvoiceNumber !== undefined && input.nextInvoiceNumber < s.company.nextInvoiceNumber) {
    throw new ServiceError('validation', 'Next invoice number cannot be lowered; issued numbers are never reused');
  }
  const fiscalChange = input.fiscalYearStartMonth !== undefined && input.fiscalYearStartMonth !== s.company.fiscalYearStartMonth;
  if (fiscalChange) await assertFiscalYearChangeable(s);
  const { version, setupDismissed, ...rest } = input;
  const [row] = await s.tx
    .update(schema.companies)
    .set({ ...rest, ...(setupDismissed !== undefined && { setupDismissedAt: setupDismissed ? sql`now()` : null }) })
    .where(and(eq(schema.companies.id, s.ctx.companyId), eq(schema.companies.version, version)))
    .returning();
  if (!row) {
    const exists = await s.tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, s.ctx.companyId));
    throw exists.length ? versionConflict('Company') : notFound('Company');
  }
  if (input.invoiceFooter !== undefined) {
    const scoped = { ...s, company: row };
    const current = await getInvoicePresentation(scoped);
    if (current.version > 0 && current.branding.defaultFooter !== input.invoiceFooter) {
      await updateInvoicePresentation(scoped, { ...current, branding: { ...current.branding, defaultFooter: input.invoiceFooter } });
    }
  }
  await recordAudit(s, {
    action: 'company.updated',
    entityType: 'company',
    entityId: row.id,
    details: { fields: [...Object.keys(rest), ...(setupDismissed !== undefined ? ['setupDismissed'] : [])], ...(fiscalChange && { fiscalYearStartMonth: { from: s.company.fiscalYearStartMonth, to: row.fiscalYearStartMonth } }), ...(input.transactionDeletionEnabled !== undefined && input.transactionDeletionEnabled !== s.company.transactionDeletionEnabled && { transactionDeletionEnabled: row.transactionDeletionEnabled }) },
  });
  return toCompanyDto(row);
}

/**
 * The fiscal year start month may change only while no accounting period is
 * closed: closed periods were chosen against the old fiscal calendar (and a
 * year-end close would be misaligned). Posted entries are allowed; reports'
 * fiscal-year presets simply re-bucket them, the ledger itself never changes.
 */
async function assertFiscalYearChangeable(s: ServiceContext): Promise<void> {
  const closed = await s.tx.execute<{ n: number }>(sql`
    select count(*)::int as n from accounting_periods where company_id = ${s.ctx.companyId} and status = 'closed'`);
  const n = Number(closed.rows[0]?.n ?? 0);
  if (n > 0) {
    throw new ServiceError(
      'invalid_state',
      `The fiscal year start month can only change while no accounting periods are closed. Reopen the ${n} closed period${n === 1 ? '' : 's'} in Settings → Periods first.`,
      { closedPeriods: n },
    );
  }
}
