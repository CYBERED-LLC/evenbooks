import { z } from 'zod';
import { getConnection, updateConnection } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

const Body = z.object({ version: z.number().int(), name: z.string().min(1).max(120).optional(), syncIntervalMinutes: z.number().int().min(60).max(1440).optional(), status: z.enum(['active', 'disabled']).optional() });
export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => getConnection(s, params.id!)));
export const PATCH = route({ body: Body, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) => inCompany(principal, (s) => updateConnection(s, params.id!, body)));
