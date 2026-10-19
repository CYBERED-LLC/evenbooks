import { InvoicePresentationInput } from '@evenbooks/contracts';
import { sampleInvoicePdf, validateInvoicePresentation } from '@evenbooks/services';
import { renderInvoicePdf } from '@evenbooks/integrations';
import { inCompany, route } from '@/server/api';
export const POST = route({ body: InvoicePresentationInput }, async ({ principal, body }) =>
  inCompany(principal, async (s) => {
    const settings = await validateInvoicePresentation(body);
    const pdf = await renderInvoicePdf(sampleInvoicePdf(s.company, settings.branding, s.company.baseCurrency));
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="sample-invoice.pdf"',
        'cache-control': 'private, no-store',
      },
    });
  }),
);
