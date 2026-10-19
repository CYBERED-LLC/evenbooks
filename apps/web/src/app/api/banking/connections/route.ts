import { ConnectSimpleFinInput } from '@evenbooks/contracts';
import { connectSimpleFin, listConnections } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { getSimpleFin } from '@/server/simplefin';

export const GET = route({}, async ({ principal }) => inCompany(principal, (s) => listConnections(s)));
export const POST = route({ body: ConnectSimpleFinInput, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => connectSimpleFin(s, getSimpleFin(), body)));
