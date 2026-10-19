import { ClosePeriodInput } from '@evenbooks/contracts';
import { closePeriod, listPeriods } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({}, async ({ principal }) => inCompany(principal, (s) => listPeriods(s)));

export const POST = route({ body: ClosePeriodInput, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => closePeriod(s, body)));
