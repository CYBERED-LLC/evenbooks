import { UpdateAccountInput } from '@evenbooks/contracts';
import { updateAccount } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const PATCH = route({ body: UpdateAccountInput, params: uuidParam('id') }, async ({ principal, body, params }) =>
  inCompany(principal, (s) => updateAccount(s, params.id!, body)),
);
