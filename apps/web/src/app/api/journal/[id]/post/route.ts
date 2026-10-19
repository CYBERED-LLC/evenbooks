import { PostJournalInput } from '@evenbooks/contracts';
import { postDraftJournal } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: PostJournalInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => postDraftJournal(s, params.id!, body.version, body.idempotencyKey)),
);
