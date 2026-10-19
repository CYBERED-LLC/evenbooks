import { syncConnection } from '@evenbooks/services';
import { route, uuidParam } from '@/server/api';
import { getDb } from '@/server/db';
import { getSimpleFin } from '@/server/simplefin';

/** Manual sync now (throttled to once per 15 minutes per connection). */
export const POST = route({ params: uuidParam('id') }, async ({ principal, params }) => syncConnection(getDb().db, getSimpleFin(), principal.company.id, params.id!, `manual:${principal.session.userId}`));
