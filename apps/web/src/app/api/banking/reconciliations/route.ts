import { z } from 'zod';
import { StartReconciliationInput } from '@evenbooks/contracts';
import { listReconciliations, startReconciliation } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Query = z.object({ bankAccountId: z.uuid().optional() });
export const GET = route({ query: Query }, async ({ principal, query }) => inCompany(principal, (s) => listReconciliations(s, query.bankAccountId)));
export const POST = route({ body: StartReconciliationInput }, async ({ principal, body }) => inCompany(principal, (s) => startReconciliation(s, body)));
