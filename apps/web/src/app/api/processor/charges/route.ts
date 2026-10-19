import { ListProcessorChargesQuery } from '@evenbooks/contracts';
import { listProcessorCharges } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListProcessorChargesQuery }, async ({ principal, query }) => inCompany(principal, (s) => listProcessorCharges(s, query)));
