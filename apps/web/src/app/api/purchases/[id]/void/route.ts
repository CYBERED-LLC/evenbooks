import { VoidPurchaseInput } from '@evenbooks/contracts';
import { voidPurchase } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: VoidPurchaseInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => voidPurchase(s, params.id!, body)));
