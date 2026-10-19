import { SendInvoiceEmailInput } from '@evenbooks/contracts';
import { queueInvoiceEmail } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

/** Queues the email; the worker sends it. `isResend` is derived from prior messages. */
export const POST = route({ body: SendInvoiceEmailInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, async (s) => {
    const { listInvoiceEmails } = await import('@evenbooks/services');
    const prior = await listInvoiceEmails(s, params.id!);
    return queueInvoiceEmail(s, params.id!, { ...body, isResend: prior.length > 0 });
  }),
);
