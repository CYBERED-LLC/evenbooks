import type { NextRequest } from 'next/server';
import { getAttachment } from '@evenbooks/services';
import { handleError, inCompany, uuidParam, type RouteContext } from '@/server/api';
import { requirePrincipal } from '@/server/company';
import { getStorage } from '@/server/storage';

/**
 * Authorized download. Every request re-checks the company context; for S3 a
 * short-lived presigned URL is returned via redirect, for local storage the
 * bytes are streamed. Objects are never publicly addressable.
 */
export async function GET(req: NextRequest, ctx: RouteContext) {
  const requestId = crypto.randomUUID();
  try {
    const principal = await requirePrincipal();
    const params = uuidParam('id').parse(await ctx.params);
    const att = await inCompany(principal, (s) => getAttachment(s, params.id!));
    if (att.status !== 'uploaded') return new Response('Not found', { status: 404 });
    const storage = getStorage();
    const inline = req.nextUrl.searchParams.get('inline') === '1';
    const presigned = await storage.presignedGetUrl(att.objectKey, { expiresInSeconds: 300, fileName: att.fileName, contentType: att.contentType });
    if (presigned) return Response.redirect(presigned, 302);
    const obj = await storage.getObject(att.objectKey);
    if (!obj) return new Response('Not found', { status: 404 });
    const safeName = att.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    return new Response(obj.body as unknown as BodyInit, {
      headers: {
        'content-type': att.contentType,
        'content-length': String(obj.size),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err) {
    return handleError(err, requestId, req);
  }
}
