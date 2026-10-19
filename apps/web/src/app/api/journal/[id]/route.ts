import { UpdateDraftJournalInput } from '@evenbooks/contracts';
import { deleteDraftJournal, getEntry, updateDraftJournal } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => getEntry(s, params.id!)));

export const PATCH = route({ body: UpdateDraftJournalInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => updateDraftJournal(s, params.id!, body)),
);

export const DELETE = route({ params: uuidParam('id') }, async ({ principal, params }) => {
  await inCompany(principal, (s) => deleteDraftJournal(s, params.id!));
  return new Response(null, { status: 204 });
});
