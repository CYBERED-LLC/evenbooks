import 'server-only';
import { env } from './env';
import { logger } from './logger';

/**
 * Team size is a plan feature: 1 member on the free tier, 20 on the paid tier
 * (Clerk's cap without the B2B add-on). The limit lives on the Clerk
 * organization, so Clerk's own invitation flow refuses invitations past it and
 * Evenbooks has nothing to police. Best effort: a failure is logged and retried the
 * next time the plan changes; the Dashboard default limit (set to the free
 * tier's value) covers brand-new organizations in the meantime.
 */
export function memberLimitFor(plan: 'free' | 'paid' | null | undefined): number {
  const limits = env().planMemberLimits;
  return plan === 'paid' ? limits.paid : limits.free;
}

export async function syncClerkMembershipLimit(orgId: string, plan: 'free' | 'paid' | null | undefined): Promise<void> {
  if (env().authMode !== 'clerk') return;
  const limit = memberLimitFor(plan);
  try {
    const { clerkClient } = await import('@clerk/nextjs/server');
    const client = await clerkClient();
    const org = await client.organizations.getOrganization({ organizationId: orgId });
    if (org.maxAllowedMemberships === limit) return;
    await client.organizations.updateOrganization(orgId, { maxAllowedMemberships: limit });
    logger.info({ orgId, plan, limit, previous: org.maxAllowedMemberships }, 'clerk membership limit synced');
  } catch (err) {
    logger.warn({ err, orgId, plan, limit }, 'could not sync clerk membership limit');
  }
}
