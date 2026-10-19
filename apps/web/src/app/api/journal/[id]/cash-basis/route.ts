import { ReviewImportedCashInput } from '@evenbooks/contracts';
import { reviewImportedCash } from '@evenbooks/services';
import { route, inCompany, uuidParam } from '@/server/api';

export const PATCH = route({ role: 'admin', params: uuidParam('id'), body: ReviewImportedCashInput }, async ({ principal, params, body }) =>
  inCompany(principal, s => reviewImportedCash(s, params.id!, body)),
);
