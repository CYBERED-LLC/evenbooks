import { z } from 'zod';
import { disconnectProcessor } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { processorDeps } from '@/server/processor';

const Body = z.object({ version: z.number().int() });

export const POST = route({ body: Body, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => disconnectProcessor(s, processorDeps(), body)));
