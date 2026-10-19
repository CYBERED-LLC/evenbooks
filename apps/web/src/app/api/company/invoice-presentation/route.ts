import { UpdateInvoicePresentationInput } from '@evenbooks/contracts';
import { getInvoicePresentation, updateInvoicePresentation } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
export const GET = route({}, async ({ principal }) => inCompany(principal, getInvoicePresentation));
export const PATCH = route({ body: UpdateInvoicePresentationInput, role: 'admin' }, async ({ principal, body }) =>
  inCompany(principal, (s) => updateInvoicePresentation(s, body)),
);
