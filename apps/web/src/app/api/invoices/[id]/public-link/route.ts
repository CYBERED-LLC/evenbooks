import { z } from 'zod';
import { getPublicLink, revokePublicLink, rotatePublicLink } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';
import { env } from '@/server/env';

const Body = z.object({ action: z.enum(['get', 'rotate', 'revoke']).default('get') });

export const POST = route({ body: Body, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, async (s) => {
    if (body.action === 'revoke') {
      await revokePublicLink(s, params.id!);
      return { url: null, path: null };
    }
    return body.action === 'rotate' ? rotatePublicLink(s, params.id!, env().publicBaseUrl) : getPublicLink(s, params.id!, env().publicBaseUrl);
  }),
);
