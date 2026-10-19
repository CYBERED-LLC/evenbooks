import { UpdateInvoiceInput, UpdateIssuedInvoiceInput } from '@evenbooks/contracts';
import { deleteDraftInvoice, getInvoice, updateDraftInvoice, updateIssuedInvoice } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => getInvoice(s, params.id!)));
export const PATCH = route({ body: UpdateInvoiceInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, async (s) => {
    const inv = await getInvoice(s, params.id!);
    if (inv.status === 'draft') return updateDraftInvoice(s, params.id!, body);
    const issued = UpdateIssuedInvoiceInput.parse(body);
    return updateIssuedInvoice(s, params.id!, issued);
  }),
);
export const DELETE = route({ params: uuidParam('id') }, async ({ principal, params }) => {
  await inCompany(principal, (s) => deleteDraftInvoice(s, params.id!));
  return new Response(null, { status: 204 });
});
