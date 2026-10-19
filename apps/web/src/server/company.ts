import 'server-only';
import { cache } from 'react';
import type { CompanyContext } from '@evenbooks/db';
import type { CompanyDto, MembershipRole } from '@evenbooks/contracts';
import { resolveCompanyForOrgDetailed, toCompanyDto } from '@evenbooks/services';
import { memberLimitFor, syncClerkMembershipLimit } from './clerk-limits';
import { getReadyDb } from './db';
import { getSession, type Session } from './auth';

export interface Principal {
  session: Session;
  company: CompanyDto;
  role: MembershipRole;
  ctx: CompanyContext;
  /** Members this company's plan allows (enforced by Clerk's organization membership limit). */
  memberLimit: number;
}

export class AuthError extends Error {
  constructor(
    public readonly kind: 'unauthenticated' | 'no_organization' | 'forbidden' | 'company_mismatch',
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Resolve the caller's company from the authenticated session. The company is
 * derived from the active organization on the server; a client-supplied
 * company id is only ever used as a consistency check (see `requirePrincipal`).
 */
export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const session = await getSession();
  if (!session) return null;
  if (!session.orgId) throw new AuthError('no_organization', 'Select or create an organization');
  const db = await getReadyDb();
  const resolved = await resolveCompanyForOrgDetailed(db.db, {
    clerkOrgId: session.orgId,
    name: session.orgName ?? 'My Company',
    actorId: session.userId,
    plan: session.plan,
  });
  const company = resolved.company;
  if (resolved.created || resolved.planChanged) await syncClerkMembershipLimit(session.orgId, company.plan);
  const role = session.role ?? 'member';
  return {
    session,
    company: toCompanyDto(company),
    role,
    ctx: { companyId: company.id, actorId: session.userId, actorType: 'user' },
    memberLimit: memberLimitFor(company.plan),
  };
});

export async function requirePrincipal(opts: { role?: MembershipRole; expectedCompanyId?: string | null } = {}): Promise<Principal> {
  const p = await getPrincipal();
  if (!p) throw new AuthError('unauthenticated', 'Sign in required');
  if (opts.role === 'admin' && p.role !== 'admin') throw new AuthError('forbidden', 'Administrator role required');
  if (opts.expectedCompanyId && opts.expectedCompanyId !== p.company.id) {
    throw new AuthError('company_mismatch', 'The active company changed; reload the page');
  }
  return p;
}
