import 'server-only';
import { csvCell } from '@/lib/csv-cell';

/** RFC 4180 CSV with stable column order; cells are quoted when needed and formula-safe (see csv-cell.ts). */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n') + '\r\n';
}

export function csvResponse(fileName: string, csv: string): Response {
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'cache-control': 'private, no-store',
    },
  });
}
