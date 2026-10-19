import { BulkContactsInput } from '@evenbooks/contracts';
import { bulkUpdateContacts } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

/** Archive or restore many contacts in one request; per-contact results carry the new versions for Undo. */
export const POST = route({ body: BulkContactsInput }, async ({ principal, body }) => inCompany(principal, (s) => bulkUpdateContacts(s, body)));
