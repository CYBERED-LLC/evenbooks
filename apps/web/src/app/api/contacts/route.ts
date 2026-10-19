import { CreateContactInput, ListContactsQuery } from '@evenbooks/contracts';
import { createContact, listContacts } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListContactsQuery }, async ({ principal, query }) => inCompany(principal, (s) => listContacts(s, query)));
export const POST = route({ body: CreateContactInput }, async ({ principal, body }) => inCompany(principal, (s) => createContact(s, body)));
