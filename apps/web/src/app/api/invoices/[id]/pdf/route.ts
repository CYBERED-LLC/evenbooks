import { z } from 'zod';
import { ensureInvoicePdf, generateInvoicePdf, listInvoicePdfVersions } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { getStorage } from '@/server/storage';
import { env } from '@/server/env';

/** GET: list versions; POST: ensure/regenerate and return the attachment id to download. */
export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, (s) => listInvoicePdfVersions(s, params.id!)));

const Body = z.object({ regenerate: z.boolean().default(false), applyCurrentDesign: z.boolean().default(false) });
export const POST = route({ body: Body, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, async (s) => {
    const attachmentId = (body.regenerate || body.applyCurrentDesign)
      ? (await generateInvoicePdf(s, getStorage(), params.id!, body.applyCurrentDesign ? 'design_updated' : 'manual', { baseUrl: env().publicBaseUrl, applyCurrentDesign: body.applyCurrentDesign })).attachmentId
      : await ensureInvoicePdf(s, getStorage(), params.id!, env().publicBaseUrl);
    return { attachmentId, downloadPath: `/api/attachments/${attachmentId}/download` };
  }),
);
