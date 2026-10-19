import { BulkInvoiceInput } from '@evenbooks/contracts';
import { bulkInvoiceAction } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';

/** Issue or email many invoices at once; per-invoice results so partial failures can be shown. */
export const POST = route({ body: BulkInvoiceInput }, async ({ principal, body }) => inCompany(principal, (s) => bulkInvoiceAction(s, body)));
