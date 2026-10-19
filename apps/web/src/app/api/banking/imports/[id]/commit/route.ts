import { CommitBatchInput } from '@evenbooks/contracts';
import { commitBatch } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: CommitBatchInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => commitBatch(s, params.id!, body.idempotencyKey)));
