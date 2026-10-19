import { BulkReviewInput } from '@evenbooks/contracts';
import { bulkReview } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

/** Review many inbox lines at once; per-line results so partial failures can be shown. */
export const POST = route({ body: BulkReviewInput }, async ({ principal, body }) => inCompany(principal, (s) => bulkReview(s, body)));
