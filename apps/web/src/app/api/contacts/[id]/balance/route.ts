import { customerBalance } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => customerBalance(s, params.id!)));
