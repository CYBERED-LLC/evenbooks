import { z } from 'zod';
import { reopenReconciliation } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

const Body = z.object({ version: z.number().int(), reason: z.string().min(1).max(500) });
export const POST = route({ body: Body, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => reopenReconciliation(s, params.id!, body.version, body.reason)));
