import { discoverAccounts } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { getSimpleFin } from '@/server/simplefin';

export const GET = route({ params: uuidParam('id'), role: 'admin' }, async ({ principal, params }) => inCompany(principal, (s) => discoverAccounts(s, getSimpleFin(), params.id!)));
