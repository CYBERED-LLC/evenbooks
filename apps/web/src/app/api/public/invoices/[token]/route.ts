import type { NextRequest } from 'next/server';
import { getPublicInvoice } from '@evenbooks/services';
import { getDb } from '@/server/db';
import { json, errorResponse } from '@/server/api';

export const dynamic = 'force-dynamic';

/** Customer-facing invoice data by revocable token. No session; only intended fields. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const found = await getPublicInvoice(getDb().db, token);
  if (!found) return errorResponse('not_found', 'This invoice link is not valid', 404);
  return json(found.dto, { headers: { 'x-robots-tag': 'noindex, nofollow' } });
}
