import { z } from 'zod';
import { transactionsPdf, transactionsReport } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { REPORT_FORMAT, pdfResponse } from '../pdf';

const Query = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), accountId: z.uuid().optional(), contactId: z.uuid().optional(), sourceType: z.string().optional(), q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(1000).optional(), cursor: z.string().optional(), format: REPORT_FORMAT });
export const GET = route({ query: Query }, async ({ principal, query }) => {
  if (query.format === 'pdf') {
    const { from, to, accountId, contactId, sourceType, q } = query;
    return pdfResponse(await inCompany(principal, (s) => transactionsPdf(s, { from, to, accountId, contactId, sourceType, q })));
  }
  const r = await inCompany(principal, (s) => transactionsReport(s, { ...query, all: query.format === 'csv' }));
  if (query.format === 'json') return r;
  return csvResponse(`transactions-${r.from}-${r.to}.csv`, toCsv(['Date', 'Entry', 'Memo', 'Source', 'Account code', 'Account', 'Contact', 'Debit', 'Credit'], r.rows.map((x) => [x.date, x.entryNumber ?? '', x.memo, x.sourceType, x.accountCode, x.accountName, x.contactName ?? '', x.debit, x.credit])));
});
