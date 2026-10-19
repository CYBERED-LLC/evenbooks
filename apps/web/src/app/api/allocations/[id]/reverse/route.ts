import { ReverseAllocationInput } from '@evenbooks/contracts';
import { reverseAllocation } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: ReverseAllocationInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => reverseAllocation(s, params.id!, body)));
