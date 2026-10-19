import { and, asc, eq, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import type { CreateTaxRateInput, TaxRateDto, UpdateTaxRateInput } from '@evenbooks/contracts';
import { notFound, versionConflict } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { getAccountByRole } from './accounts';

type TaxRateRow = typeof schema.taxRates.$inferSelect;

export function toTaxRateDto(t: TaxRateRow): TaxRateDto {
  return {
    id: t.id,
    name: t.name,
    rate: t.rate,
    agency: t.agency,
    liabilityAccountId: t.liabilityAccountId,
    isActive: t.isActive,
    version: t.version,
  };
}

export async function listTaxRates(s: ServiceContext, opts: { includeInactive?: boolean; withUsage?: boolean } = {}): Promise<TaxRateDto[]> {
  const conds = [eq(schema.taxRates.companyId, s.ctx.companyId)];
  if (!opts.includeInactive) conds.push(eq(schema.taxRates.isActive, true));
  if (!opts.withUsage) {
    const rows = await s.tx
      .select()
      .from(schema.taxRates)
      .where(and(...conds))
      .orderBy(asc(schema.taxRates.name));
    return rows.map(toTaxRateDto);
  }
  // Usage in the same statement: each side is aggregated once per company by
  // unnesting the rate-id arrays, then joined to the rates (no per-rate queries).
  const cid = s.ctx.companyId;
  const itemUse = sql`(
    select r as tax_rate_id, count(*)::int as n
      from items i cross join lateral unnest(i.default_tax_rate_ids) as r
     where i.company_id = ${cid} and i.is_active
     group by r) as item_use`;
  const invoiceUse = sql`(
    select r as tax_rate_id, count(distinct l.invoice_id)::int as n
      from invoice_lines l
      join invoices v on v.id = l.invoice_id and v.company_id = l.company_id
      cross join lateral unnest(l.tax_rate_ids) as r
     where l.company_id = ${cid} and v.status = 'issued' and v.balance_due > 0
     group by r) as invoice_use`;
  const rows = await s.tx
    .select({ rate: schema.taxRates, items: sql<number>`coalesce(item_use.n, 0)`, openInvoices: sql<number>`coalesce(invoice_use.n, 0)` })
    .from(schema.taxRates)
    .leftJoin(itemUse, sql`item_use.tax_rate_id = ${schema.taxRates.id}`)
    .leftJoin(invoiceUse, sql`invoice_use.tax_rate_id = ${schema.taxRates.id}`)
    .where(and(...conds))
    .orderBy(asc(schema.taxRates.name));
  return rows.map((r) => ({ ...toTaxRateDto(r.rate), usage: { items: Number(r.items), openInvoices: Number(r.openInvoices) } }));
}

export async function getTaxRate(s: ServiceContext, id: string): Promise<TaxRateRow> {
  const [row] = await s.tx
    .select()
    .from(schema.taxRates)
    .where(and(eq(schema.taxRates.companyId, s.ctx.companyId), eq(schema.taxRates.id, id)))
    .limit(1);
  if (!row) throw notFound('Tax rate');
  return row;
}

/**
 * Tax rates post to the company's sales-tax-payable control account. Issued
 * documents snapshot the rate, so editing a rate never changes history.
 */
export async function createTaxRate(s: ServiceContext, input: CreateTaxRateInput): Promise<TaxRateDto> {
  const liability = await getAccountByRole(s, 'sales_tax_payable');
  const [row] = await s.tx
    .insert(schema.taxRates)
    .values({
      companyId: s.ctx.companyId,
      name: input.name.trim(),
      rate: input.rate,
      agency: input.agency ?? null,
      liabilityAccountId: liability.id,
    })
    .returning();
  await recordAudit(s, { action: 'tax_rate.created', entityType: 'tax_rate', entityId: row!.id, details: { name: row!.name, rate: row!.rate } });
  return toTaxRateDto(row!);
}

export async function updateTaxRate(s: ServiceContext, id: string, input: UpdateTaxRateInput): Promise<TaxRateDto> {
  await getTaxRate(s, id);
  const { version, ...rest } = input;
  const [row] = await s.tx
    .update(schema.taxRates)
    .set({ ...rest, name: rest.name?.trim() })
    .where(and(eq(schema.taxRates.companyId, s.ctx.companyId), eq(schema.taxRates.id, id), eq(schema.taxRates.version, version)))
    .returning();
  if (!row) throw versionConflict('Tax rate');
  await recordAudit(s, { action: 'tax_rate.updated', entityType: 'tax_rate', entityId: id, details: { fields: Object.keys(rest) } });
  return toTaxRateDto(row);
}
