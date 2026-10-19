import type { NextRequest } from 'next/server';
import { PaymentProcessorError } from '@evenbooks/integrations';
import { ingestProcessorEvent } from '@evenbooks/services';
import { getDb } from '@/server/db';
import { env } from '@/server/env';
import { logger } from '@/server/logger';
import { processorDeps } from '@/server/processor';

export const dynamic = 'force-dynamic';

/**
 * Stripe Connect webhook (one platform endpoint; events carry the connected
 * account id). The signature is verified on the raw body, the event is stored
 * before anything changes, and processing runs in the connection's company.
 * Duplicates are acknowledged; processing failures are acknowledged too and
 * retried by the worker, because Evenbooks owns the retry.
 *
 * With the fixture driver (never in production) deliveries are unsigned JSON.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const deps = processorDeps();
  if (deps.client.driver === 'fixture' && env().isProduction) return new Response('forbidden', { status: 403 });
  let event;
  try {
    event = deps.client.constructEvent(raw, req.headers.get('stripe-signature'));
  } catch (err) {
    // Match by name too: the dev bundler can load the integrations package twice, and then
    // `instanceof` fails for an error thrown by the other copy.
    if (err instanceof PaymentProcessorError || (err instanceof Error && err.name === 'PaymentProcessorError')) {
      logger.warn({ kind: (err as PaymentProcessorError).kind, err: err.message }, 'rejected processor webhook');
      return new Response('invalid', { status: 400 });
    }
    throw err;
  }
  const outcome = await ingestProcessorEvent(getDb().db, deps, event);
  logger.info({ eventId: event.id, type: event.type, account: event.accountId, outcome: outcome.status, error: outcome.error }, 'processor webhook');
  return new Response(JSON.stringify({ received: true, outcome: outcome.status }), { status: 200, headers: { 'content-type': 'application/json' } });
}
