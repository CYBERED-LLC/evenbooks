import { CreateManualJournalInput, ListJournalQuery } from '@evenbooks/contracts';
import { createManualJournal, listEntries } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListJournalQuery }, async ({ principal, query }) => inCompany(principal, (s) => listEntries(s, query)));

export const POST = route({ body: CreateManualJournalInput }, async ({ principal, body }) =>
  inCompany(principal, (s) => createManualJournal(s, body)),
);
