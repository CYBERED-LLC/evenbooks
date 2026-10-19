import { UpdateTaxRateInput } from '@evenbooks/contracts';
import { updateTaxRate } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const PATCH = route({ body: UpdateTaxRateInput, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => updateTaxRate(s, params.id!, body)),
);
