import { z } from 'zod';
import { generalLedger, generalLedgerPdf } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { REPORT_FORMAT, pdfResponse } from '../pdf';

const Query = z.object({ accountId: z.uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), limit: z.coerce.number().int().min(1).max(2000).optional(), cursor: z.string().optional(), format: REPORT_FORMAT });
export const GET = route({ query: Query }, async ({ principal, query }) => {
  if (query.format === 'pdf') return pdfResponse(await inCompany(principal, (s) => generalLedgerPdf(s, { accountId: query.accountId, from: query.from, to: query.to })));
  const r = await inCompany(principal, (s) => generalLedger(s, { ...query, all: query.format === 'csv' }));
  if (query.format === 'json') return r;
  return csvResponse(`general-ledger-${r.code}-${r.from}-${r.to}.csv`, toCsv(['Date', 'Entry', 'Memo', 'Line memo', 'Source', 'Debit', 'Credit', 'Balance'], [['', '', 'Opening balance', '', '', '', '', r.opening], ...r.lines.map((l) => [l.date, l.entryNumber ?? '', l.memo, l.lineMemo ?? '', l.sourceType, l.debit, l.credit, l.running])]));
});
