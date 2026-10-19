import { OpeningBalancesInput } from '@evenbooks/contracts';
import { postOpeningBalances } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const POST = route({ body: OpeningBalancesInput, role: 'admin' }, async ({ principal, body }) =>
  inCompany(principal, (s) => postOpeningBalances(s, body)),
);
