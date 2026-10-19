import { UpdateLedgerImportInput } from '@evenbooks/contracts';
import { getLedgerImport, updateLedgerImport } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { getStorage } from '@/server/storage';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => getLedgerImport(s, getStorage(), params.id!)));
export const PATCH = route({ body: UpdateLedgerImportInput, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => updateLedgerImport(s, getStorage(), params.id!, body)),
);
