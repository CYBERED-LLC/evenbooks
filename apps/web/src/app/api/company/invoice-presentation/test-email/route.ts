import { TestInvoiceEmailInput } from '@evenbooks/contracts';
import { queueTestInvoiceEmail } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
export const POST = route({ body: TestInvoiceEmailInput, role: 'admin' }, async ({ principal, body }) =>
  inCompany(principal, (s) => queueTestInvoiceEmail(s, { to: body.to, idempotencyKey: body.idempotencyKey, presentation: body })),
);
