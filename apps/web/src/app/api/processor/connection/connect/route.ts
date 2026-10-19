import { connectProcessor } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { env } from '@/server/env';
import { processorDeps } from '@/server/processor';

/** Start or resume Stripe onboarding; returns the hosted onboarding URL. */
export const POST = route({ role: 'admin' }, async ({ principal }) => {
  const base = env().publicBaseUrl;
  return inCompany(principal, (s) => connectProcessor(s, processorDeps(), { returnUrl: `${base}/settings/payments?onboarding=return`, refreshUrl: `${base}/settings/payments?onboarding=refresh` }));
});
