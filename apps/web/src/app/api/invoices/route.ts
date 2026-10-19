import { CreateInvoiceInput, ListInvoicesQuery } from '@evenbooks/contracts';
import { createDraftInvoice, listInvoices } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

export const GET = route({ query: ListInvoicesQuery }, async ({ principal, query }) => inCompany(principal, (s) => listInvoices(s, query)));
export const POST = route({ body: CreateInvoiceInput }, async ({ principal, body }) => inCompany(principal, (s) => createDraftInvoice(s, body)));
