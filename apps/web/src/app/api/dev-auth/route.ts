import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/server/env';
import { DEV_COOKIE, DEV_ORGS, DEV_USERS, encodeDevSession, readDevSession } from '@/server/dev-auth';
import { json, errorResponse } from '@/server/api';

const Body = z.object({
  userId: z.string().optional(),
  orgId: z.string(),
  orgRole: z.enum(['org:admin', 'org:member']).optional(),
  /** Override the org's default plan (fixture for Clerk Billing). */
  plan: z.enum(['free', 'paid']).optional(),
});

export async function GET() {
  if (env().authMode !== 'dev') return errorResponse('not_found', 'Not found', 404);
  const session = await readDevSession();
  return json({ users: DEV_USERS, orgs: DEV_ORGS, session });
}

export async function POST(req: NextRequest) {
  if (env().authMode !== 'dev') return errorResponse('not_found', 'Not found', 404);
  const body = Body.parse(await req.json());
  const current = await readDevSession();
  const userId = body.userId ?? current?.userId;
  const user = DEV_USERS.find((u) => u.userId === userId);
  // Throwaway orgs let browser tests start from a brand-new, empty company.
  const org = DEV_ORGS.find((o) => o.orgId === body.orgId) ?? (/^org_dev_e2e_[a-z0-9_]+$/.test(body.orgId) ? { orgId: body.orgId, orgName: `E2E ${body.orgId.slice(12)}`, plan: 'free' as const } : undefined);
  if (!user || !org) return errorResponse('validation', 'Unknown dev user or org', 400);
  const value = encodeDevSession({
    userId: user.userId,
    userName: user.userName,
    orgId: org.orgId,
    orgName: org.orgName,
    orgRole: body.orgRole ?? current?.orgRole ?? 'org:admin',
    plan: body.plan ?? org.plan,
  });
  const store = await cookies();
  store.set(DEV_COOKIE, value, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30 });
  return json({ ok: true });
}

export async function DELETE() {
  const store = await cookies();
  store.delete(DEV_COOKIE);
  return json({ ok: true });
}
