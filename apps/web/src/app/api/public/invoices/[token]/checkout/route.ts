import type { NextRequest } from 'next/server';
import { PublicCheckoutInput } from '@evenbooks/contracts';
import { createPublicCheckout, ServiceError } from '@evenbooks/services';
import { getDb } from '@/server/db';
import { env } from '@/server/env';
import { json, errorResponse, handleError } from '@/server/api';
import { processorDeps } from '@/server/processor';
import { logger } from '@/server/logger';

export const dynamic = 'force-dynamic';

/**
 * Customer-facing: open a hosted checkout for an invoice reached by its public
 * token. No session. The redirect back to the invoice page never proves
 * payment; the books change only when the provider's webhook arrives.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  let body: unknown = {};
  const text = await req.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse('validation', 'Malformed JSON body', 400);
    }
  }
  const parsed = PublicCheckoutInput.safeParse(body);
  if (!parsed.success) return errorResponse('validation', 'Invalid request', 400, parsed.error.issues);
  const base = env().publicBaseUrl;
  const page = `${base}/i/${encodeURIComponent(token)}`;
  try {
    const out = await createPublicCheckout(getDb().db, processorDeps(), token, parsed.data, { successUrl: `${page}?checkout=success`, cancelUrl: `${page}?checkout=cancel` });
    return json(out, { headers: { 'x-robots-tag': 'noindex, nofollow' } });
  } catch (err) {
    if (err instanceof ServiceError && err.code === 'not_found') return errorResponse('not_found', 'This invoice link is not valid', 404);
    if (err instanceof ServiceError) return errorResponse(err.code, err.message, err.status);
    logger.error({ err }, 'public checkout failed');
    return handleError(err, 'public-checkout', req);
  }
}
