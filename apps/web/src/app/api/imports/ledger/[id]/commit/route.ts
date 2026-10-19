import { CommitLedgerImportInput } from '@evenbooks/contracts';
import { commitLedgerImport } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { getStorage } from '@/server/storage';

export const POST = route({ body: CommitLedgerImportInput, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => commitLedgerImport(s, getStorage(), params.id!, body.idempotencyKey)),
);
