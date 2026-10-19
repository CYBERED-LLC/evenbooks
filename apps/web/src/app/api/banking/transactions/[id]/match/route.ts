import { MatchInput } from '@evenbooks/contracts';
import { matchTransaction } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: MatchInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => matchTransaction(s, params.id!, body)));
