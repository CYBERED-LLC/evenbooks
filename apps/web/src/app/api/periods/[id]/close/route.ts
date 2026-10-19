import { z } from 'zod';
import { recloseperiod } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

const Body = z.object({ version: z.number().int(), reason: z.string().max(500).optional() });

export const POST = route({ body: Body, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => recloseperiod(s, params.id!, body.version, body.reason)),
);
