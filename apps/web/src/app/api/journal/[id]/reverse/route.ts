import { ReverseJournalInput } from '@evenbooks/contracts';
import { reverseEntry } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: ReverseJournalInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => reverseEntry(s, params.id!, body)),
);
