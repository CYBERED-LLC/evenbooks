import { RefundProcessorChargeInput } from '@evenbooks/contracts';
import { refundProcessorCharge } from '@evenbooks/services';
import { route, uuidParam } from '@/server/api';
import { getDb } from '@/server/db';
import { processorDeps } from '@/server/processor';

/**
 * Refund an online payment through the processor (administrators only: real
 * money leaves the connected account, so the gate matches connecting Stripe).
 * The service runs the network call between two transactions, so it takes the
 * database handle rather than a company transaction.
 */
export const POST = route({ body: RefundProcessorChargeInput, params: uuidParam('id'), role: 'admin' }, async ({ principal, params, body }) =>
  refundProcessorCharge(getDb().db, processorDeps(), principal.ctx, params.id!, body),
);
