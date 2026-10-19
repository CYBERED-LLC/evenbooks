import { emailConfigFromEnv, renderInvoiceEmail, type EmailConfig } from '@evenbooks/integrations';
import type { InvoicePresentation } from '@evenbooks/domain';
import type { ServiceContext } from './context';
import { getInvoicePresentation, validateInvoicePresentation, sampleInvoiceEmail, sampleInvoicePdf } from './invoice-presentation';
import { resolveCompanyEmailSender } from './company-email-senders';
import { loadInvoice, getPublicLink } from './invoices';
import { publicOnlinePaymentInfo } from './processor';
import { invoicePdfData } from './invoice-pdf';
import { snapshotInvoiceDesign } from './invoice-presentation';

export interface EmailContentOptions {
  subject?: string;
  message?: string | null;
  usePlatformSender?: boolean;
  config?: EmailConfig;
  baseUrl?: string;
  presentation?: InvoicePresentation;
  preview?: boolean;
}
export async function invoiceEmailContent(s: ServiceContext, invoiceId: string | undefined, options: EmailContentOptions = {}) {
  const saved = await getInvoicePresentation(s);
  const presentation = options.presentation ? await validateInvoicePresentation(options.presentation) : saved;
  const config = options.config ?? emailConfigFromEnv();
  const sender = await resolveCompanyEmailSender(s, config, options.usePlatformSender);
  const replyTo = presentation.email.replyTo ?? s.company.email ?? config.replyTo;
  if (!invoiceId) {
    return {
      ...renderInvoiceEmail(sampleInvoiceEmail(s.company, s.company.baseCurrency), presentation, options),
      ...sender,
      replyTo,
      logo: presentation.branding.logo,
      sample: true,
      templateVersion: saved.version,
      pdfAttachmentId: null,
      pdfData: sampleInvoicePdf(s.company, presentation.branding, s.company.baseCurrency),
    };
  }
  const inv = await loadInvoice(s, invoiceId);
  const design = inv.designSnapshot ?? (await snapshotInvoiceDesign(s));
  const link =
    process.env.APP_ENCRYPTION_KEY && !inv.publicTokenRevokedAt
      ? (await getPublicLink(s, inv.id, options.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000')).url
      : null;
  const online = link ? await publicOnlinePaymentInfo(s, inv) : null;
  const rendered = renderInvoiceEmail(
    {
      number: inv.number ?? 'Draft',
      customerName: inv.customerSnapshot.name,
      companyName: design.issuer.name,
      issueDate: inv.issueDate,
      dueDate: inv.dueDate,
      total: inv.total,
      balanceDue: inv.balanceDue,
      currency: inv.currency,
      invoiceUrl: link,
      paymentUrl: online ? link : inv.paymentUrl,
    },
    { ...presentation, branding: design.branding },
    options,
  );
  // Keep the payment method information shared by the existing invoice flow.
  if (online && link)
    rendered.text = rendered.text.replace(
      `Pay online: ${link}`,
      `Pay online by ${online.methods.map((m) => (m === 'ach' ? 'bank debit' : 'card')).join(' or ')}: ${link}`,
    );
  return {
    ...rendered,
    ...sender,
    replyTo,
    logo: design.branding.logo,
    sample: false,
    templateVersion: saved.version,
    pdfAttachmentId: inv.currentPdfAttachmentId,
    ...(!inv.currentPdfAttachmentId && {
      pdfData: await invoicePdfData(s, inv, design, { baseUrl: options.baseUrl ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000' }),
    }),
  };
}
