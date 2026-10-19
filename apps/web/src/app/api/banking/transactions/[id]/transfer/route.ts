import { TransferInput } from '@evenbooks/contracts';
import { transferTransaction } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: TransferInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => transferTransaction(s, params.id!, body)));
