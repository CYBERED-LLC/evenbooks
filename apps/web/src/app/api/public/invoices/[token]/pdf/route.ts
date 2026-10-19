import type { NextRequest } from 'next/server';
import { getPublicInvoicePdfObject } from '@evenbooks/services';
import { getDb } from '@/server/db';
import { getStorage } from '@/server/storage';

export const dynamic = 'force-dynamic';

/** PDF download for the public invoice page (current version only). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const att = await getPublicInvoicePdfObject(getDb().db, token);
  if (!att) return new Response('Not found', { status: 404 });
  const obj = await getStorage().getObject(att.objectKey);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body as unknown as BodyInit, {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${att.fileName}"`, 'cache-control': 'private, no-store', 'x-robots-tag': 'noindex' },
  });
}
