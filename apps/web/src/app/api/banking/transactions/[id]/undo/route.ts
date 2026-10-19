import { UndoReviewInput } from '@evenbooks/contracts';
import { undoReview } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: UndoReviewInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => undoReview(s, params.id!, body)));
