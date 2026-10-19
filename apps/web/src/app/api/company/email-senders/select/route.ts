import { z } from 'zod';
import { selectCompanyEmailSender, refreshCompanyEmailSender } from '@evenbooks/services';
import { createEmailIdentityManagerFromEnv } from '@evenbooks/integrations';
import { inCompany, route } from '@/server/api';
export const POST = route({ body: z.object({ id: z.uuid().nullable() }), role: 'admin' }, async ({ principal, body }) => {
  const manager = await createEmailIdentityManagerFromEnv();
  // Commit verification changes even when selecting an unverified sender is refused.
  if (body.id) await inCompany(principal, (s) => refreshCompanyEmailSender(s, body.id!, manager));
  return inCompany(principal, (s) => selectCompanyEmailSender(s, body.id));
});
