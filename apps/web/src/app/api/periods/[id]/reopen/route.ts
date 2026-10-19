import { ReopenPeriodInput } from '@evenbooks/contracts';
import { reopenPeriod } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: ReopenPeriodInput, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => reopenPeriod(s, params.id!, body)),
);
