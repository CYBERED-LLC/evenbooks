import { InvoiceEmailPreviewInput } from '@evenbooks/contracts';
import { invoiceEmailContent } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { env } from '@/server/env';
export const POST = route({ body: InvoiceEmailPreviewInput }, async ({ principal, body }) =>
  inCompany(principal, async (s) => {
    const result = await invoiceEmailContent(s, body.invoiceId, { ...body, baseUrl: env().publicBaseUrl, preview: true });
    return {
      from: result.from,
      replyTo: result.replyTo,
      subject: result.subject,
      message: result.message,
      text: result.text,
      html: result.html,
      templateVersion: result.templateVersion,
    };
  }),
);
