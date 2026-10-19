import { deleteAttachment, getAttachment, toAttachmentDto } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { getStorage } from '@/server/storage';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, async (s) => toAttachmentDto(await getAttachment(s, params.id!))));
export const DELETE = route({ params: uuidParam('id') }, async ({ principal, params }) => {
  await inCompany(principal, (s) => deleteAttachment(s, getStorage(), params.id!));
  return new Response(null, { status: 204 });
});
