import { CreateCreditNoteInput, ListCreditNotesQuery } from '@evenbooks/contracts';
import { createDraftCreditNote, listCreditNotes } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListCreditNotesQuery }, async ({ principal, query }) => inCompany(principal, (s) => listCreditNotes(s, query)));
export const POST = route({ body: CreateCreditNoteInput }, async ({ principal, body }) => inCompany(principal, (s) => createDraftCreditNote(s, body)));
