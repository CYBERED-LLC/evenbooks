import { VoidPaymentInput } from '@evenbooks/contracts';
import { voidPayment } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: VoidPaymentInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => voidPayment(s, params.id!, body)));
