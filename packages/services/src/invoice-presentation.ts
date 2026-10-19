import { and, desc, eq, sql } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { DEFAULT_INVOICE_BRANDING, DEFAULT_INVOICE_EMAIL } from '@evenbooks/domain';
import { InvoicePresentationInput, type InvoicePresentationDto, type UpdateInvoicePresentationInput } from '@evenbooks/contracts';
import { invoiceLogoBytes, renderInvoiceEmail, renderInvoicePdf, type InvoiceEmailData } from '@evenbooks/integrations';
import type { ServiceContext } from './context';
import { ServiceError, versionConflict } from './errors';
import { recordAudit } from './audit';

export async function getInvoicePresentation(s: ServiceContext): Promise<InvoicePresentationDto> {
  const [latest] = await s.tx
    .select()
    .from(schema.invoicePresentationVersions)
    .where(eq(schema.invoicePresentationVersions.companyId, s.ctx.companyId))
    .orderBy(desc(schema.invoicePresentationVersions.version))
    .limit(1);
  return latest
    ? { ...latest.presentation, branding: { ...DEFAULT_INVOICE_BRANDING, ...latest.presentation.branding }, version: latest.version }
    : {
        version: 0,
        branding: { ...DEFAULT_INVOICE_BRANDING, defaultFooter: s.company.invoiceFooter },
        email: { ...DEFAULT_INVOICE_EMAIL },
      };
}
export async function validateInvoicePresentation(input: unknown) {
  const result = InvoicePresentationInput.parse(input);
  if (result.branding.logo) {
    try {
      invoiceLogoBytes(result.branding.logo);
      // Decode as well as checking dimensions, so malformed compressed data cannot reach workers.
      await renderInvoicePdf(sampleInvoicePdf({ name: 'Preview', email: null, phone: null, address: {} }, result.branding));
    } catch (err) {
      throw new ServiceError('validation', `Invalid logo: ${(err as Error).message}`);
    }
  }
  return result;
}
export async function updateInvoicePresentation(s: ServiceContext, input: UpdateInvoicePresentationInput) {
  const presentation = await validateInvoicePresentation(input);
  // Serialize version allocation and protect against two administrators overwriting each other.
  await s.tx.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, s.ctx.companyId)).for('update');
  const current = await getInvoicePresentation(s);
  if (current.version !== input.version) throw versionConflict('Invoice settings');
  const version = current.version + 1;
  await s.tx
    .insert(schema.invoicePresentationVersions)
    .values({ companyId: s.ctx.companyId, version, presentation, createdBy: s.ctx.actorId });
  await s.tx
    .update(schema.companies)
    .set({ invoiceFooter: presentation.branding.defaultFooter })
    .where(
      and(
        eq(schema.companies.id, s.ctx.companyId),
        sql`${schema.companies.invoiceFooter} is distinct from ${presentation.branding.defaultFooter}`,
      ),
    );
  await recordAudit(s, { action: 'invoice.presentation_updated', entityType: 'company', entityId: s.ctx.companyId, details: { version } });
  return { ...presentation, version };
}
export async function snapshotInvoiceDesign(s: ServiceContext) {
  const settings = await getInvoicePresentation(s);
  return {
    issuer: { name: s.company.name, email: s.company.email, phone: s.company.phone, address: s.company.address },
    branding: settings.branding,
    templateVersion: settings.version,
  };
}
export function sampleInvoiceEmail(company: { name: string }, currency = 'USD'): InvoiceEmailData {
  return {
    number: 'INV-SAMPLE',
    customerName: 'Sample customer',
    companyName: company.name,
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    total: '1250.00',
    balanceDue: '1250.00',
    currency,
    invoiceUrl: null,
    paymentUrl: null,
  };
}
export function sampleInvoicePdf(
  company: Parameters<typeof renderInvoicePdf>[0]['company'],
  branding: InvoicePresentationDto['branding'],
  currency = 'USD',
): Parameters<typeof renderInvoicePdf>[0] {
  return {
    number: 'INV-SAMPLE',
    status: 'issued',
    issueDate: '2026-01-01',
    dueDate: '2026-01-31',
    company,
    customer: { name: 'Sample customer', email: 'customer@example.com' },
    lines: [
      {
        description: 'Professional services',
        quantity: '10',
        unitPrice: '125',
        lineDiscount: '0',
        total: '1250',
        net: '1250',
        taxTotal: '0',
      },
    ],
    currency,
    subtotal: '1250',
    discountTotal: '0',
    taxSummary: [],
    taxTotal: '0',
    total: '1250',
    amountSettled: '0',
    balanceDue: '1250',
    memo: branding.defaultNotes,
    footer: branding.defaultFooter,
    branding,
  };
}
export async function previewInvoicePresentation(s: ServiceContext, input?: unknown) {
  const presentation = input ? await validateInvoicePresentation(input) : await getInvoicePresentation(s);
  return renderInvoiceEmail(sampleInvoiceEmail(s.company, s.company.baseCurrency), presentation, { preview: true });
}
export async function listInvoicePresentationVersions(s: ServiceContext) {
  return s.tx
    .select({
      version: schema.invoicePresentationVersions.version,
      createdAt: schema.invoicePresentationVersions.createdAt,
      createdBy: schema.invoicePresentationVersions.createdBy,
    })
    .from(schema.invoicePresentationVersions)
    .where(eq(schema.invoicePresentationVersions.companyId, s.ctx.companyId))
    .orderBy(desc(schema.invoicePresentationVersions.version));
}
