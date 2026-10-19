import { z } from 'zod';
import { QueryBoolean } from '@evenbooks/contracts';
import { CreateTaxRateInput } from '@evenbooks/contracts';
import { createTaxRate, listTaxRates } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

const Query = z.object({ includeInactive: QueryBoolean.optional(), withUsage: QueryBoolean.optional() });
export const GET = route({ query: Query }, async ({ principal, query }) => inCompany(principal, (s) => listTaxRates(s, { includeInactive: query.includeInactive, withUsage: query.withUsage })));
export const POST = route({ body: CreateTaxRateInput, role: 'admin' }, async ({ principal, body }) => inCompany(principal, (s) => createTaxRate(s, body)));
