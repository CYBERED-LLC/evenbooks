import { z } from 'zod';
import { PROFIT_AND_LOSS_CSV_HEADERS, profitAndLoss, profitAndLossCsvRows, profitAndLossPdf } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { ISO_DATE, REPORT_FORMAT, pdfResponse } from '../pdf';

const Query = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), basis: z.enum(['accrual', 'cash']).default('accrual'), compareFrom: ISO_DATE.optional(), compareTo: ISO_DATE.optional(), format: REPORT_FORMAT });
export const GET = route({ query: Query }, async ({ principal, query }) => {
  const { format, compareFrom, compareTo, ...params } = query;
  if (format === 'pdf') return pdfResponse(await inCompany(principal, (s) => profitAndLossPdf(s, { ...params, compareFrom, compareTo })));
  const r = await inCompany(principal, (s) => profitAndLoss(s, params));
  if (format === 'json') return r;
  return csvResponse(`profit-and-loss-${r.basis}-${r.from}-${r.to}.csv`, toCsv(PROFIT_AND_LOSS_CSV_HEADERS, profitAndLossCsvRows(r)));
});
