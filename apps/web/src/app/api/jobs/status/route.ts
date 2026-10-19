import { jobStatus } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({}, async ({ principal }) => inCompany(principal, (s) => jobStatus(s)));
