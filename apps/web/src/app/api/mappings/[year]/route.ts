import { z } from 'zod';
import { listMappings, setMappings } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Params = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
const Body = z.object({ entries: z.array(z.object({ accountId: z.uuid(), lineCode: z.string().max(10).nullable() })).min(1).max(500) });

export const GET = route({ params: Params }, async ({ principal, params }) => inCompany(principal, (s) => listMappings(s, params.year)));
export const PUT = route({ params: Params, body: Body, role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, async (s) => {
    await setMappings(s, params.year, body.entries);
    return listMappings(s, params.year);
  }),
);
