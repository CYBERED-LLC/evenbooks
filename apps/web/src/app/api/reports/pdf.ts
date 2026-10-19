import 'server-only';
import { z } from 'zod';
import { type ReportPdf, renderReport } from '@evenbooks/services';

export const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Every report route accepts the same three formats. */
export const REPORT_FORMAT = z.enum(['json', 'csv', 'pdf']).default('json');

/** Render a report built inside the company transaction and send it as a download. */
export async function pdfResponse(report: ReportPdf): Promise<Response> {
  const pdf = await renderReport(report);
  return new Response(new Uint8Array(pdf), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${report.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'content-length': String(pdf.length),
      'cache-control': 'private, no-store',
    },
  });
}
