import { UpdateBankAccountInput } from '@evenbooks/contracts';
import { updateBankAccount } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const PATCH = route({ body: UpdateBankAccountInput, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => updateBankAccount(s, params.id!, body)),
);
