import { snapshotInvoiceDesign } from './invoice-presentation';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import { Money } from '@evenbooks/domain';
import { renderInvoicePdf, sha256, type ObjectStorage } from '@evenbooks/integrations';
import { ServiceError } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { getPublicLink, loadInvoice } from './invoices';
import { objectKey } from './attachments';

/**
 * Generate and store the PDF for an issued invoice. Every generation is a new
 * versioned attachment linked to the document (`invoice_pdfs`); earlier
 * versions are never overwritten, so an email sent yesterday still points at
 * yesterday's file. The PDF renders only snapshotted invoice data, never live
 * contact/item records.
 */
async function lockInvoice(s: ServiceContext, invoiceId: string) {
  // Serialize PDF generation per invoice: concurrent jobs (issue → PDF, email → ensure PDF)
  // would otherwise race on the version number.
  const [row] = await s.tx
    .select()
    .from(schema.invoices)
    .where(and(eq(schema.invoices.companyId, s.ctx.companyId), eq(schema.invoices.id, invoiceId)))
    .for('update');
  if (!row) throw new ServiceError('not_found', 'Invoice not found');
  return row;
}

export async function invoicePdfData(
  s: ServiceContext,
  inv: Awaited<ReturnType<typeof loadInvoice>>,
  design: Awaited<ReturnType<typeof snapshotInvoiceDesign>>,
  opts: { baseUrl?: string } = {},
): Promise<Parameters<typeof renderInvoicePdf>[0]> {
  const lines = await s.tx.select().from(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, inv.id)).orderBy(asc(schema.invoiceLines.lineNo));
  const cur = inv.currency;
  const publicUrl = opts.baseUrl && !inv.publicTokenRevokedAt && process.env.APP_ENCRYPTION_KEY ? (await getPublicLink(s, inv.id, opts.baseUrl)).url : null;
  return {
    number: inv.number!,
    status: inv.status as 'issued' | 'paid' | 'void',
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    company: design.issuer,
    branding: design.branding,
    customer: { name: inv.customerSnapshot.name, email: inv.customerSnapshot.email, address: inv.customerSnapshot.address },
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity.replace(/\.?0+$/, ''),
      unitPrice: l.unitPrice,
      lineDiscount: Money.round(l.lineDiscount, cur).toString(),
      total: Money.round(l.total, cur).toString(),
      net: Money.round(l.net, cur).toString(),
      taxTotal: Money.round(l.taxTotal, cur).toString(),
    })),
    currency: cur,
    subtotal: Money.round(inv.subtotal, cur).toString(),
    discountTotal: Money.round(inv.discountTotal, cur).toString(),
    taxSummary: inv.taxSummary.map((t) => ({ name: t.name, rate: t.rate, amount: t.amount })),
    taxTotal: Money.round(inv.taxTotal, cur).toString(),
    total: Money.round(inv.total, cur).toString(),
    amountSettled: Money.round(inv.amountSettled, cur).toString(),
    balanceDue: Money.round(inv.balanceDue, cur).toString(),
    memo: inv.memo,
    footer: inv.footer,
    paymentUrl: inv.paymentUrl,
    publicUrl,
  };
}

export async function generateInvoicePdf(
  s: ServiceContext,
  storage: ObjectStorage,
  invoiceId: string,
  reason: string,
  opts: { baseUrl?: string; applyCurrentDesign?: boolean; preserveCurrentPdf?: boolean; data?: Parameters<typeof renderInvoicePdf>[0] } = {},
): Promise<{ attachmentId: string; version: number; sha256: string }> {
  await lockInvoice(s, invoiceId);
  const inv = await loadInvoice(s, invoiceId);
  const currentDesign = opts.applyCurrentDesign || !inv.designSnapshot ? await snapshotInvoiceDesign(s) : null;
  const design = opts.applyCurrentDesign
    ? { ...currentDesign!, issuer: inv.designSnapshot?.issuer ?? currentDesign!.issuer }
    : (inv.designSnapshot ?? currentDesign!);
  if (inv.status === 'draft') throw new ServiceError('invalid_state', 'Issue the invoice before generating a PDF');
  const pdf = await renderInvoicePdf(opts.data ?? (await invoicePdfData(s, inv, design, opts)));
  const [latest] = await s.tx
    .select({ version: schema.invoicePdfs.version })
    .from(schema.invoicePdfs)
    .where(eq(schema.invoicePdfs.invoiceId, invoiceId))
    .orderBy(desc(schema.invoicePdfs.version))
    .limit(1);
  const version = (latest?.version ?? 0) + 1;
  const attachmentId = randomUUID();
  const fileName = `${inv.number}${version > 1 ? `-v${version}` : ''}.pdf`;
  const key = objectKey(s.ctx.companyId, 'invoice_pdf', attachmentId, fileName);
  const digest = sha256(pdf);
  await s.tx.insert(schema.attachments).values({
    id: attachmentId,
    companyId: s.ctx.companyId,
    kind: 'invoice_pdf',
    objectKey: key,
    fileName,
    contentType: 'application/pdf',
    sizeBytes: pdf.byteLength,
    sha256: digest,
    status: 'pending',
    entityType: 'invoice',
    entityId: invoiceId,
    uploadedBy: s.ctx.actorId,
  });
  await storage.putObject(key, pdf, 'application/pdf');
  await s.tx.update(schema.attachments).set({ status: 'uploaded', completedAt: new Date().toISOString() }).where(eq(schema.attachments.id, attachmentId));
  await s.tx.insert(schema.invoicePdfs).values({ companyId: s.ctx.companyId, invoiceId, attachmentId, version, reason });
  if (!opts.preserveCurrentPdf || !inv.currentPdfAttachmentId) {
    await s.tx
      .update(schema.invoices)
      .set({ currentPdfAttachmentId: attachmentId, ...(opts.applyCurrentDesign && { designSnapshot: design }) })
      .where(eq(schema.invoices.id, invoiceId));
  }
  await recordAudit(s, { action: 'invoice.pdf_generated', entityType: 'invoice', entityId: invoiceId, details: { version, reason, sha256: digest } });
  return { attachmentId, version, sha256: digest };
}

/** Return the current PDF, generating one if the invoice has none yet. */
export async function ensureInvoicePdf(s: ServiceContext, storage: ObjectStorage, invoiceId: string, baseUrl?: string): Promise<string> {
  const inv = await lockInvoice(s, invoiceId);
  if (inv.currentPdfAttachmentId) return inv.currentPdfAttachmentId;
  return (await generateInvoicePdf(s, storage, invoiceId, 'on_demand', { baseUrl })).attachmentId;
}

export async function listInvoicePdfVersions(s: ServiceContext, invoiceId: string) {
  return s.tx
    .select({
      version: schema.invoicePdfs.version,
      attachmentId: schema.invoicePdfs.attachmentId,
      reason: schema.invoicePdfs.reason,
      createdAt: schema.invoicePdfs.createdAt,
      sha256: schema.attachments.sha256,
    })
    .from(schema.invoicePdfs)
    .innerJoin(schema.attachments, eq(schema.attachments.id, schema.invoicePdfs.attachmentId))
    .where(and(eq(schema.invoicePdfs.companyId, s.ctx.companyId), eq(schema.invoicePdfs.invoiceId, invoiceId)))
    .orderBy(desc(schema.invoicePdfs.version));
}
