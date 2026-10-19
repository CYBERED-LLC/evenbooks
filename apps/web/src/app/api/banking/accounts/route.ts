import { z } from 'zod';
import { QueryBoolean } from '@evenbooks/contracts';
import { CreateBankAccountInput } from '@evenbooks/contracts';
import { createBankAccount, listBankAccounts } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Query = z.object({ includeInactive: QueryBoolean.optional() });
export const GET = route({ query: Query }, async ({ principal, query }) => inCompany(principal, (s) => listBankAccounts(s, { includeInactive: query.includeInactive })));
export const POST = route({ body: CreateBankAccountInput, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => createBankAccount(s, body)));
