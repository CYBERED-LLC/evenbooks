import { discardLedgerImport } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ params: uuidParam('id'), role: 'admin' }, async ({ principal, params }) => {
  await inCompany(principal, (s) => discardLedgerImport(s, params.id!));
  return new Response(null, { status: 204 });
});
