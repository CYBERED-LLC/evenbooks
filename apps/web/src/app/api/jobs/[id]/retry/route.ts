import { retryFailedJob } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

/** Re-run one failed background job (admin). Idempotent per failed job; see `retryFailedJob`. */
export const POST = route({ params: uuidParam('id'), role: 'admin' }, async ({ principal, params }) => inCompany(principal, (s) => retryFailedJob(s, params.id!)));
