import { z } from 'zod';
import { balanceSheet, balanceSheetPdf } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { ISO_DATE, REPORT_FORMAT, pdfResponse } from '../pdf';

const Query = z.object({ asOf: ISO_DATE, compareAsOf: ISO_DATE.optional(), format: REPORT_FORMAT });
export const GET = route({ query: Query }, async ({ principal, query }) => {
  if (query.format === 'pdf') return pdfResponse(await inCompany(principal, (s) => balanceSheetPdf(s, { asOf: query.asOf, compareAsOf: query.compareAsOf })));
  const r = await inCompany(principal, (s) => balanceSheet(s, { asOf: query.asOf }));
  if (query.format === 'json') return r;
  const rows: (string | number)[][] = [];
  for (const [section, lines] of [['Assets', r.assets], ['Liabilities', r.liabilities], ['Equity', r.equity]] as const) for (const l of lines) rows.push([section, l.code, l.name, l.amount]);
  rows.push(['Equity', '', 'Profit from earlier years', r.retainedEarningsPriorYears], ['Equity', '', 'Profit this year so far', r.currentYearEarnings]);
  rows.push(['Total', '', 'Total assets', r.totalAssets], ['Total', '', 'Total liabilities', r.totalLiabilities], ['Total', '', 'Total equity', r.totalEquity]);
  return csvResponse(`balance-sheet-${r.asOf}.csv`, toCsv(['Section', 'Code', 'Account', 'Amount'], rows));
});
