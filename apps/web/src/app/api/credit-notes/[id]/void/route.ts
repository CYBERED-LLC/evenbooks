import { VoidCreditNoteInput } from '@evenbooks/contracts';
import { voidCreditNote } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: VoidCreditNoteInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => voidCreditNote(s, params.id!, body)));
