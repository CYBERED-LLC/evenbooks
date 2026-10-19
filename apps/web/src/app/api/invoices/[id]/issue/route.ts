import { IssueInvoiceInput } from '@evenbooks/contracts';
import { issueInvoice } from '@evenbooks/services';
import { inCompany, route, uuidParam } from '@/server/api';

export const POST = route({ body: IssueInvoiceInput, params: uuidParam('id') }, async ({ principal, params, body }) => inCompany(principal, (s) => issueInvoice(s, params.id!, body)));
