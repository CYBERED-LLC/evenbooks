import { RecordInvoicePaymentInput } from '@evenbooks/contracts';
import { recordInvoicePayment } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: RecordInvoicePaymentInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => recordInvoicePayment(s, params.id!, body)));
