import { InvoiceCandidatesQuery } from '@evenbooks/contracts';
import { invoiceCandidates } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ query: InvoiceCandidatesQuery, params: uuidParam('id') }, async ({ principal, params, query }) => inCompany(principal, (s) => invoiceCandidates(s, params.id!, query)));
