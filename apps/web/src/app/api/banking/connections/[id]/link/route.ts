import { LinkProviderAccountsInput } from '@evenbooks/contracts';
import { linkProviderAccounts } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: LinkProviderAccountsInput, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) => inCompany(principal, (s) => linkProviderAccounts(s, params.id!, body)));
