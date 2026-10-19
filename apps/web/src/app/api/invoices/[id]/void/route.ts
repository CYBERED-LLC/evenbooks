import { VoidInvoiceInput } from '@evenbooks/contracts';
import { voidInvoice } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: VoidInvoiceInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => voidInvoice(s, params.id!, body)));
