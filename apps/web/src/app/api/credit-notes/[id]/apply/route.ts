import { ApplyCreditNoteInput } from '@evenbooks/contracts';
import { applyCreditNote } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: ApplyCreditNoteInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => applyCreditNote(s, params.id!, body)));
