import { z } from 'zod';
import { copyMappings, listMappings } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Params = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
const Body = z.object({ fromYear: z.number().int().min(2000).max(2100) });
export const POST = route({ params: Params, body: Body, role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, async (s) => {
    const copied = await copyMappings(s, body.fromYear, params.year);
    return { copied, ...(await listMappings(s, params.year)) };
  }),
);
