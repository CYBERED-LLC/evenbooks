import { z } from 'zod';
import { AGING_BUCKET_LABELS, type AgingBucketKey, outstandingInvoices, outstandingInvoicesPdf } from '@evenbooks/services';
import { inCompany, route } from '@/server/api';
import { csvResponse, toCsv } from '@/server/csv';
import { ISO_DATE, REPORT_FORMAT, pdfResponse } from '../pdf';

const Query = z.object({ asOf: ISO_DATE.optional(),
  bucket: z.enum(Object.keys(AGING_BUCKET_LABELS) as [AgingBucketKey, ...AgingBucketKey[]]).optional(),
  group: z.enum(['invoice', 'customer']).optional(),
  format: REPORT_FORMAT });
export const GET = route({ query: Query }, async ({ principal, query }) => {
  if (query.format === 'pdf') return pdfResponse(await inCompany(principal, (s) => outstandingInvoicesPdf(s, { asOf: query.asOf, bucket: query.bucket, group: query.group })));
  const r = await inCompany(principal, (s) => outstandingInvoices(s, { asOf: query.asOf }));
  if (query.format === 'json') return r;
  return csvResponse(`outstanding-invoices-${r.asOf}.csv`, toCsv(['Number', 'Customer', 'Issue date', 'Due date', 'Total', 'Balance due', 'Days overdue'], r.items.map((i) => [i.number, i.contactName, i.issueDate, i.dueDate, i.total, i.balanceDue, i.daysOverdue])));
});
