import { UpdateCompanyInput } from '@evenbooks/contracts';
import { updateCompany } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({}, async ({ principal }) => principal.company);

export const PATCH = route({ body: UpdateCompanyInput, role: 'admin' }, async ({ principal, body }) =>
  inCompany(principal, (s) => updateCompany(s, body)),
);
