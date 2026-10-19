import { SenderSetupInput } from '@evenbooks/contracts';
import { listCompanyEmailSenders, setupCompanyEmailSender } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { createEmailIdentityManagerFromEnv } from '@evenbooks/integrations';
export const GET = route({ role: 'admin' }, async ({ principal }) => inCompany(principal, listCompanyEmailSenders));
export const POST = route({ body: SenderSetupInput, role: 'admin' }, async ({ principal, body }) => {
  const manager = await createEmailIdentityManagerFromEnv();
  return inCompany(principal, (s) => setupCompanyEmailSender(s, body, manager));
});
