import { runScheduleIssuance } from '@evenbooks/services';
import { route, uuidParam } from '@/server/api';
import { getDb } from '@/server/db';

/** Manual "issue due occurrences now" (same code path as the worker). */
export const POST = route({ params: uuidParam('id') }, async ({ principal, params }) => runScheduleIssuance(getDb().db, principal.company.id, params.id!, `manual:${principal.session.userId}`));
