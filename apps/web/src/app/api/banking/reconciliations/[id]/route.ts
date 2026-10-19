import { deleteReconciliation, getReconciliation } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => getReconciliation(s, params.id!)));
export const DELETE = route({ params: uuidParam('id') }, async ({ principal, params }) => {
  await inCompany(principal, (s) => deleteReconciliation(s, params.id!));
  return new Response(null, { status: 204 });
});
