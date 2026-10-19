import { z } from 'zod';
import { PlainDateString } from '@evenbooks/contracts';
import { trialBalance, trialBalancePdf } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { REPORT_FORMAT, pdfResponse } from '../pdf';

// Older bookmarked exports used `to`; its end date now selects the snapshot.
const Query = z.object({ asOf: PlainDateString.optional(), to: PlainDateString.optional(), format: REPORT_FORMAT })
  .refine((q) => !!(q.asOf || q.to), { message: 'Choose an as-of date' })
  .transform((q) => ({ asOf: q.asOf ?? q.to!, format: q.format }));
export const GET = route({ query: Query }, async ({ principal, query }) => {
  if (query.format === 'pdf') return pdfResponse(await inCompany(principal, (s) => trialBalancePdf(s, query)));
  const r = await inCompany(principal, (s) => trialBalance(s, query));
  if (query.format === 'json') return r;
  return csvResponse(`trial-balance-${r.asOf}.csv`, toCsv(['Code', 'Account', 'Type', 'Debit', 'Credit'], [...r.rows.map((x) => [x.code, x.name, x.type, x.debit, x.credit]), ['', 'Total', '', r.totalDebit, r.totalCredit]]));
});
