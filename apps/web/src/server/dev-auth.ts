import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { env } from './env';

/**
 * Cookie-based development authentication. Only active when AUTH_MODE=dev
 * (never in production). Lets local development and browser tests exercise
 * multi-user, multi-company flows without Clerk credentials.
 */
export interface DevSession {
  userId: string;
  userName: string;
  orgId: string;
  orgName: string;
  orgRole: 'org:admin' | 'org:member';
  /** Stands in for the Clerk Billing plan. */
  plan?: 'free' | 'paid';
}

export const DEV_COOKIE = 'evenbooks_dev_session';

export const DEV_USERS: { userId: string; userName: string }[] = [
  { userId: 'user_dev_owner', userName: 'Dana Owner' },
  { userId: 'user_dev_bookkeeper', userName: 'Blair Bookkeeper' },
];

export const DEV_ORGS: { orgId: string; orgName: string; plan: 'free' | 'paid' }[] = [
  { orgId: 'org_dev_alpha', orgName: 'Alpha Consulting LLC', plan: 'free' },
  { orgId: 'org_dev_beta', orgName: 'Beta Design Studio', plan: 'paid' },
];

function sign(payload: string): string {
  return createHmac('sha256', env().devSessionSecret).update(payload).digest('base64url');
}

export function encodeDevSession(s: DevSession): string {
  const payload = Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeDevSession(value: string | undefined): DevSession | null {
  if (!value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DevSession;
    if (!parsed.userId || !parsed.orgId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function readDevSession(): Promise<DevSession | null> {
  const store = await cookies();
  return decodeDevSession(store.get(DEV_COOKIE)?.value);
}
