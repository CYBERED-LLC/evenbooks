import { z } from 'zod';
import { reconnectSimpleFin } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { getSimpleFin } from '@/server/simplefin';

const Body = z.object({ version: z.number().int(), setupToken: z.string().min(16).max(4000) });
export const POST = route({ body: Body, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) => inCompany(principal, (s) => reconnectSimpleFin(s, getSimpleFin(), params.id!, body)));
