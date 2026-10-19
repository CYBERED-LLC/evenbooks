import type { NextRequest } from 'next/server';
import { env } from '@/server/env';
import { getDb } from '@/server/db';
import { resolveCompanyForOrgDetailed } from '@evenbooks/services';
import { syncClerkMembershipLimit } from '@/server/clerk-limits';
import { json, errorResponse } from '@/server/api';
import { logger } from '@/server/logger';

/**
 * Clerk webhook: provisions a company when an organization is created so the
 * books exist before the first visit. Deletions are NOT propagated: financial
 * records survive membership/organization changes (see docs/decisions.md).
 */
export async function POST(req: NextRequest) {
  const e = env();
  if (e.authMode !== 'clerk' || !e.clerkWebhookSecret) return errorResponse('not_found', 'Not found', 404);
  try {
    const { verifyWebhook } = await import('@clerk/nextjs/webhooks');
    const evt = await verifyWebhook(req, { signingSecret: e.clerkWebhookSecret });
    if (evt.type === 'organization.created' || evt.type === 'organization.updated') {
      const org = evt.data as { id: string; name: string; created_by?: string | null; public_metadata?: { plan?: unknown } };
      // Billing plans normally sync on each signed-in request (auth().has({ plan })); organizations
      // flagged through public metadata (`plan: "paid"`) sync here as well.
      const meta = org.public_metadata?.plan;
      const plan = meta === 'paid' ? 'paid' : meta === 'free' ? 'free' : null;
      const resolved = await resolveCompanyForOrgDetailed(getDb().db, { clerkOrgId: org.id, name: org.name, actorId: org.created_by ?? 'clerk-webhook', plan });
      if (resolved.created || resolved.planChanged) await syncClerkMembershipLimit(org.id, resolved.company.plan);
    }
    return json({ received: true });
  } catch (err) {
    logger.warn({ err }, 'clerk webhook rejected');
    return errorResponse('validation', 'Invalid webhook', 400);
  }
}
