import { UpdateItemInput } from '@evenbooks/contracts';
import { updateItem } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const PATCH = route({ body: UpdateItemInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => updateItem(s, params.id!, body)));
