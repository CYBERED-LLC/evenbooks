import { ToggleReconciliationItemsInput } from '@evenbooks/contracts';
import { toggleReconciliationItems } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: ToggleReconciliationItemsInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => toggleReconciliationItems(s, params.id!, body)),
);
