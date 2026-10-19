import { CategorizeInput } from '@evenbooks/contracts';
import { categorizeTransaction } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: CategorizeInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => categorizeTransaction(s, params.id!, body)));
