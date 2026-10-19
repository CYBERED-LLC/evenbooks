import { VoidRefundInput } from '@evenbooks/contracts';
import { voidRefund } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: VoidRefundInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => voidRefund(s, params.id!, body)));
