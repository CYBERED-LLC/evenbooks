import { UpdateCreditNoteInput } from '@evenbooks/contracts';
import { deleteDraftCreditNote, getCreditNote, updateDraftCreditNote } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => getCreditNote(s, params.id!)));
export const PATCH = route({ body: UpdateCreditNoteInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => updateDraftCreditNote(s, params.id!, body)));
export const DELETE = route({ params: uuidParam('id') }, async ({ principal, params }) => {
  await inCompany(principal, (s) => deleteDraftCreditNote(s, params.id!));
  return new Response(null, { status: 204 });
});
