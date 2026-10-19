import { IssueCreditNoteInput } from '@evenbooks/contracts';
import { issueCreditNote } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: IssueCreditNoteInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => issueCreditNote(s, params.id!, body)));
