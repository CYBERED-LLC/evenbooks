import { z } from 'zod';
import { QueryBoolean } from '@evenbooks/contracts';
import { CreateAccountInput } from '@evenbooks/contracts';
import { createAccount, listAccounts } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Query = z.object({
  includeArchived: QueryBoolean.optional(),
  withBalances: QueryBoolean.optional(),
});

export const GET = route({ query: Query }, async ({ principal, query }) =>
  inCompany(principal, (s) => listAccounts(s, { includeArchived: query.includeArchived, withBalances: query.withBalances })),
);

export const POST = route({ body: CreateAccountInput }, async ({ principal, body }) => inCompany(principal, (s) => createAccount(s, body)));
