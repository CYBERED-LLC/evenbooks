import { UpdateContactInput } from '@evenbooks/contracts';
import { getContact, toContactDto, updateContact } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const GET = route({ params: uuidParam('id') }, async ({ principal, params }) => inCompany(principal, async (s) => toContactDto(await getContact(s, params.id!))));
export const PATCH = route({ body: UpdateContactInput, params: uuidParam('id') }, async ({ principal, params, body }) =>
  inCompany(principal, (s) => updateContact(s, params.id!, body)),
);
