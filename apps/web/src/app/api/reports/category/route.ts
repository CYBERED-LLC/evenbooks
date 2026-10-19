import { z } from 'zod';
import { categoryReport, categoryReportPdf } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { ISO_DATE, REPORT_FORMAT, pdfResponse } from '../pdf';

const Query = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), basis: z.enum(['accrual', 'cash']).default('accrual'), compareFrom: ISO_DATE.optional(), compareTo: ISO_DATE.optional(), format: REPORT_FORMAT });
export const GET = route({ query: Query }, async ({ principal, query }) => {
  const { format, compareFrom, compareTo, ...params } = query;
  if (format === 'pdf') return pdfResponse(await inCompany(principal, (s) => categoryReportPdf(s, { ...params, compareFrom, compareTo })));
  const r = await inCompany(principal, (s) => categoryReport(s, params));
  if (format === 'json') return r;
  const rows: (string | number)[][] = [];
  for (const g of r.groups) for (const l of g.lines) rows.push([g.type, l.code, l.name, l.count, l.amount]);
  rows.push(['net', '', 'Net income', '', r.netIncome]);
  return csvResponse(`categories-${r.basis}-${r.from}-${r.to}.csv`, toCsv(['Type', 'Code', 'Account', 'Transactions', 'Amount'], rows));
});
