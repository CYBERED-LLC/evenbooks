import { ExcludeInput } from '@evenbooks/contracts';
import { excludeTransaction } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: ExcludeInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => excludeTransaction(s, params.id!, body)));
