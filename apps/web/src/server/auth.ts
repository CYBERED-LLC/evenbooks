import 'server-only';
import { cache } from 'react';
import { env } from './env';
import { readDevSession } from './dev-auth';
import type { MembershipRole } from '@evenbooks/contracts';

/**
 * Authentication adapter. Resolves the signed-in user and the active
 * organization from Clerk (production) or the dev cookie (local/testing).
 * Nothing downstream depends on which provider produced the session.
 */
export interface Session {
  userId: string;
  userName: string | null;
  orgId: string | null;
  orgName: string | null;
  /** Application role derived from the organization membership. */
  role: MembershipRole | null;
  /** Billing plan of the active organization as the identity provider reports it (null when unknown). */
  plan: 'free' | 'paid' | null;
}

export const getSession = cache(async (): Promise<Session | null> => {
  const e = env();
  if (e.authMode === 'clerk') {
    const { auth, currentUser, clerkClient } = await import('@clerk/nextjs/server');
    const a = await auth();
    if (!a.userId) return null;
    const user = await currentUser().catch(() => null);
    // The org name comes from a custom session claim (`org_name: {{org.name}}`,
    // configured on the Clerk instance). Fall back to the Backend API when the
    // claim is absent so a new company is never provisioned under a placeholder.
    let orgName = (a.sessionClaims as { org_name?: string } | undefined)?.org_name ?? null;
    if (a.orgId && !orgName) {
      orgName = await clerkClient()
        .then((c) => c.organizations.getOrganization({ organizationId: a.orgId! }))
        .then((o) => o.name)
        .catch(() => null);
    }
    return {
      userId: a.userId,
      userName: user ? [user.firstName, user.lastName].filter(Boolean).join(' ') || user.primaryEmailAddress?.emailAddress || null : null,
      orgId: a.orgId ?? null,
      orgName,
      role: a.orgId ? mapClerkRole(a.orgRole) : null,
      plan: a.orgId ? clerkPlan(a as unknown as { has?: (p: Record<string, string>) => boolean; sessionClaims?: Record<string, unknown> | null }, e.clerkPaidPlanSlugs) : null,
    };
  }
  const dev = await readDevSession();
  if (!dev) return null;
  return {
    userId: dev.userId,
    userName: dev.userName,
    orgId: dev.orgId,
    orgName: dev.orgName,
    role: mapClerkRole(dev.orgRole),
    plan: dev.plan ?? 'free',
  };
});

/**
 * Paid tier = the active organization holds one of the configured Clerk
 * Billing plans (`auth().has({ plan })`), or, for instances without Billing, a
 * session claim `org_plan` (custom claim `{{org.public_metadata.plan}}`) equal
 * to "paid". Anything else is the free tier.
 */
export function clerkPlan(a: { has?: (p: Record<string, string>) => boolean; sessionClaims?: Record<string, unknown> | null }, paidSlugs: string[]): 'free' | 'paid' {
  for (const slug of paidSlugs) {
    try {
      if (a.has?.({ plan: slug })) return 'paid';
    } catch {
      // has() throws when Billing is not enabled on the instance; fall through to the claim
    }
  }
  const claim = a.sessionClaims?.org_plan;
  return claim === 'paid' ? 'paid' : 'free';
}

export function mapClerkRole(orgRole: string | null | undefined): MembershipRole {
  return orgRole === 'org:admin' || orgRole === 'admin' ? 'admin' : 'member';
}
