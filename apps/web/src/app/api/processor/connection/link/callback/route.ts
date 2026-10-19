import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ServiceError, linkProcessorAccount } from '@evenbooks/services';
import { PaymentProcessorError } from '@evenbooks/integrations';
import { inCompany } from '@/server/api';
import { AuthError, requirePrincipal } from '@/server/company';
import { env } from '@/server/env';
import { logger } from '@/server/logger';
import { processorDeps } from '@/server/processor';
import { LINK_COOKIE } from '../shared';

function back(params: Record<string, string>): NextResponse {
  const u = new URL('/settings/payments', env().publicBaseUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u, 303);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Stripe returns here after the administrator signs in and authorizes Evenbooks (or declines). */
export async function GET(req: NextRequest): Promise<Response> {
  const q = req.nextUrl.searchParams;
  const store = await cookies();
  const saved = store.get(LINK_COOKIE)?.value ?? '';
  store.delete({ name: LINK_COOKIE, path: '/api/processor/connection/link' });
  const [nonce = '', companyId = ''] = saved.split('.');
  const state = q.get('state') ?? '';
  if (!nonce || !sameText(nonce, state)) return back({ link: 'error', message: 'The Stripe sign-in expired or was started in another browser. Try again.' });
  const error = q.get('error');
  if (error) return back(error === 'access_denied' ? { link: 'denied' } : { link: 'error', message: q.get('error_description') ?? error });
  const code = q.get('code');
  if (!code) return back({ link: 'error', message: 'Stripe did not return an authorization code.' });
  try {
    const principal = await requirePrincipal({ role: 'admin', expectedCompanyId: companyId });
    await inCompany(principal, (s) => linkProcessorAccount(s, processorDeps(), { code }));
    return back({ link: 'done' });
  } catch (err) {
    if (err instanceof AuthError || err instanceof ServiceError) return back({ link: 'error', message: err.message });
    // Match by name as well: the Next dev bundle can load the integrations package twice.
    if (err instanceof PaymentProcessorError || (err as Error)?.name === 'PaymentProcessorError') {
      logger.warn({ err }, 'stripe link failed');
      return back({ link: 'error', message: `Stripe: ${(err as Error).message}` });
    }
    logger.error({ err }, 'stripe link callback failed');
    return back({ link: 'error', message: 'Something went wrong while connecting Stripe.' });
  }
}
