import { z } from 'zod';
import { disconnect } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: z.object({ version: z.number().int() }), params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) => inCompany(principal, (s) => disconnect(s, params.id!, body.version)));
