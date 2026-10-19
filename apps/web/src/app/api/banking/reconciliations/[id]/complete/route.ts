import { CompleteReconciliationInput } from '@evenbooks/contracts';
import { completeReconciliation } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: CompleteReconciliationInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => completeReconciliation(s, params.id!, body)),
);
