import { refreshCompanyEmailSender } from '@evenbooks/services';
import { createEmailIdentityManagerFromEnv } from '@evenbooks/integrations';
import { inCompany, route, uuidParam } from '@/server/api';
export const POST = route({ params: uuidParam('id'), role: 'admin' }, async ({ principal, params }) => {
  const manager = await createEmailIdentityManagerFromEnv();
  return inCompany(principal, (s) => refreshCompanyEmailSender(s, params.id!, manager));
});
