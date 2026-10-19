import { cancelCompanyEmailSender } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ params: uuidParam('id'), role: 'admin' }, async ({ principal, params }) =>
  inCompany(principal, (s) => cancelCompanyEmailSender(s, params.id!)),
);
