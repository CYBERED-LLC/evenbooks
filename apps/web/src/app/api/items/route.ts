import { z } from 'zod';
import { QueryBoolean } from '@evenbooks/contracts';
import { CreateItemInput } from '@evenbooks/contracts';
import { createItem, listItems } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Query = z.object({ includeInactive: QueryBoolean.optional() });
export const GET = route({ query: Query }, async ({ principal, query }) => inCompany(principal, (s) => listItems(s, { includeInactive: query.includeInactive })));
export const POST = route({ body: CreateItemInput }, async ({ principal, body }) => inCompany(principal, (s) => createItem(s, body)));
