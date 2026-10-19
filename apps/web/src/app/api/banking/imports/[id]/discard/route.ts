import { discardBatch } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ params: uuidParam('id') }, async ({ principal, params }) => {
  await inCompany(principal, (s) => discardBatch(s, params.id!));
  return new Response(null, { status: 204 });
});
