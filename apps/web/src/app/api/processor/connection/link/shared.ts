import 'server-only';
import { env } from '@/server/env';

export const LINK_COOKIE = 'eb_stripe_link';

/** Must match a redirect URI registered in the Stripe Connect OAuth settings. */
export function linkCallbackUrl(): string {
  return `${env().publicBaseUrl}/api/processor/connection/link/callback`;
}
