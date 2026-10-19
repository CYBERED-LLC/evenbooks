import { AllocatePaymentInput } from '@evenbooks/contracts';
import { allocatePayment } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: AllocatePaymentInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => allocatePayment(s, params.id!, body)));
