import { z } from 'zod';
import { pauseSchedule } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: z.object({ version: z.number().int() }), params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => pauseSchedule(s, params.id!, body.version)));
