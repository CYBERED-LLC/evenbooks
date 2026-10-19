import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { startProcessorLink } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { env } from '@/server/env';
import { processorDeps } from '@/server/processor';
import { LINK_COOKIE, linkCallbackUrl } from './shared';

/**
 * Start connecting an existing Stripe account (Connect OAuth). The state
 * nonce is also kept in an httpOnly cookie, so the callback only completes
 * a flow this browser started, for the company it started in.
 */
export const POST = route({ role: 'admin' }, async ({ principal }) => {
  const nonce = randomBytes(24).toString('base64url');
  const out = await inCompany(principal, (s) => startProcessorLink(s, processorDeps(), { state: nonce, redirectUri: linkCallbackUrl() }));
  const store = await cookies();
  store.set(LINK_COOKIE, `${nonce}.${principal.company.id}`, { httpOnly: true, sameSite: 'lax', secure: env().publicBaseUrl.startsWith('https:'), path: '/api/processor/connection/link', maxAge: 15 * 60 });
  return out;
});
