import { z } from 'zod';
import { scheduleCPdf, scheduleCSummary } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { REPORT_FORMAT, pdfResponse } from '../pdf';

const Query = z.object({ taxYear: z.coerce.number().int().min(2000).max(2100), basis: z.enum(['accrual', 'cash']).default('cash'), format: REPORT_FORMAT });
export const GET = route({ query: Query }, async ({ principal, query }) => {
  if (query.format === 'pdf') return pdfResponse(await inCompany(principal, (s) => scheduleCPdf(s, { taxYear: query.taxYear, basis: query.basis })));
  const r = await inCompany(principal, (s) => scheduleCSummary(s, query));
  if (query.format === 'json') return r;
  const rows: (string | number)[][] = [];
  for (const l of r.lines) {
    rows.push([l.code, l.label, '', '', l.amount]);
    for (const a of l.accounts) rows.push([l.code, '', a.code, a.name, a.amount]);
  }
  for (const u of r.unmapped) rows.push(['UNMAPPED', '', u.code, u.name, u.amount]);
  rows.push(['', 'Gross receipts (1 - 2 + 6)', '', '', r.grossReceipts], ['', 'Total expenses', '', '', r.totalExpenses], ['', 'Tentative profit', '', '', r.tentativeProfit]);
  return csvResponse(`schedule-c-${r.taxYear}-${r.basis}.csv`, toCsv(['Line', 'Label', 'Account code', 'Account', 'Amount'], rows));
});
