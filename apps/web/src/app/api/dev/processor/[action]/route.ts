import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { FixturePaymentProcessor, type ProcessorEvent } from '@evenbooks/integrations';
import { ingestProcessorEvent } from '@evenbooks/services';
import { getDb } from '@/server/db';
import { env } from '@/server/env';
import { json, errorResponse } from '@/server/api';
import { processorDeps } from '@/server/processor';

export const dynamic = 'force-dynamic';

/**
 * Fixture-only controls that stand in for Stripe's side of the world: the
 * customer paying, ACH settling, onboarding finishing, an existing account
 * being linked, payouts arriving. Each
 * action produces Stripe-shaped events that go through the same ingestion the
 * webhook uses. Refused unless the fixture driver is active and not in production.
 */
const Body = z.object({
  sessionId: z.string().optional(),
  accountId: z.string().optional(),
  method: z.enum(['card', 'ach']).optional(),
  payerEmail: z.string().optional(),
  outcome: z.enum(['succeeded', 'failed']).optional(),
  amount: z.string().optional(),
  currency: z.string().optional(),
  arrivalDate: z.string().optional(),
  description: z.string().optional(),
  paymentIntentId: z.string().optional(),
  disputeId: z.string().optional(),
  payoutId: z.string().optional(),
  result: z.enum(['won', 'lost']).optional(),
  balance: z.string().optional(),
  displayName: z.string().optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const deps = processorDeps();
  if (env().isProduction || deps.client.driver !== 'fixture') return errorResponse('not_found', 'Not found', 404);
  const fx = deps.client as FixturePaymentProcessor;
  const { action } = await ctx.params;
  const body = Body.parse(await req.json().catch(() => ({})));
  try {
    let events: ProcessorEvent[];
    let code: string | null = null;
    switch (action) {
      case 'authorize-link': {
        const out = fx.authorizeLink({ accountId: body.accountId, displayName: body.displayName, currency: body.currency, balance: body.balance });
        code = out.code;
        events = [];
        break;
      }
      case 'deauthorize':
        events = [fx.deauthorize(body.accountId!)];
        break;
      case 'complete-checkout':
        events = fx.completeCheckout(body.sessionId!, { method: body.method, payerEmail: body.payerEmail ?? null });
        break;
      case 'settle-ach':
        events = fx.settleAch(body.sessionId!, body.outcome ?? 'succeeded');
        break;
      case 'complete-onboarding':
        events = [fx.completeOnboarding(body.accountId!)];
        break;
      case 'restrict-account':
        events = [fx.restrictAccount(body.accountId!)];
        break;
      case 'external-charge':
        events = [fx.externalCharge(body.accountId!, body.amount!, body.currency ?? 'USD', { description: body.description, method: body.method, payerEmail: body.payerEmail ?? null })];
        break;
      case 'external-refund':
        events = [fx.externalRefund(body.accountId!, body.paymentIntentId!, body.amount!)];
        break;
      case 'payout':
        events = [fx.payout(body.accountId!, body.amount!, body.currency ?? 'USD', body.arrivalDate ?? new Date().toISOString().slice(0, 10), { description: body.description })];
        break;
      case 'fail-payout':
        events = [fx.failPayout(body.payoutId!)];
        break;
      case 'open-dispute':
        events = [fx.openDispute(body.accountId!, body.paymentIntentId!, { amount: body.amount })];
        break;
      case 'close-dispute':
        events = [fx.closeDispute(body.disputeId!, body.result ?? 'won')];
        break;
      default:
        return errorResponse('not_found', `Unknown fixture action ${action}`, 404);
    }
    const outcomes = [];
    for (const e of events) outcomes.push({ id: e.id, type: e.type, ...(await ingestProcessorEvent(getDb().db, deps, e)) });
    const session = body.sessionId ? fx.sessions.get(body.sessionId) : undefined;
    return json({ outcomes, code, successUrl: session?.successUrl ?? null, cancelUrl: session?.cancelUrl ?? null });
  } catch (err) {
    return errorResponse('validation', (err as Error).message, 400);
  }
}
