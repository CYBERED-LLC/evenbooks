import { CreatePurchaseInput, ListPurchasesQuery } from '@evenbooks/contracts';
import { createPurchase, listPurchases } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListPurchasesQuery }, async ({ principal, query }) => inCompany(principal, (s) => listPurchases(s, query)));
export const POST = route({ body: CreatePurchaseInput }, async ({ principal, body }) => inCompany(principal, (s) => createPurchase(s, body)));
