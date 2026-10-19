import { z } from 'zod';
import { pendingReviewSummary } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { ISO_DATE } from '../pdf';

/**
 * Bank transactions still waiting for review, dated in `from`–`to` (or on or
 * before `to` for as-of reports). Reports warn that these are not in them yet.
 */
const Query = z.object({ from: ISO_DATE.optional(), to: ISO_DATE });
export const GET = route({ query: Query }, async ({ principal, query }) => inCompany(principal, (s) => pendingReviewSummary(s, { from: query.from ?? null, to: query.to })));
