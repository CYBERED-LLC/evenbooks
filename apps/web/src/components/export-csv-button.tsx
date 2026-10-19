'use client';
import * as React from 'react';
import { Download } from 'lucide-react';
import type { Page } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { ActionMenu, phoneHidden } from '@/components/ui/action-menu';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api-client';
import { useCompany } from '@/components/company-context';
import { csvCell as cell } from '@/lib/csv-cell';

export interface CsvColumn<T> {
  header: string;
  value(row: T): string | number | null | undefined;
}

/** RFC 4180 CSV, quoted and formula-safe like the server's report exports (src/server/csv.ts). */
export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(','), ...rows.map((r) => columns.map((c) => cell(c.value(r))).join(','))];
  return `${lines.join('\r\n')}\r\n`;
}

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ExportCsvButtonProps<T> {
  /** List endpoint, e.g. "/api/invoices". */
  path: string;
  /** The list's current filters (no cursor/limit); every matching row is exported, page by page. */
  query: Record<string, string | number | boolean | undefined | null>;
  columns: CsvColumn<T>[];
  filename: string;
  /** Safety stop for runaway exports. */
  maxRows?: number;
}

/**
 * "Export CSV" for list pages: pages through the list endpoint with the current filters.
 * On phones it moves into a "More actions" menu at the end of the header so the
 * primary action keeps its row.
 */
export function ExportCsvButton<T>({ path, query, columns, filename, maxRows = 20_000 }: ExportCsvButtonProps<T>) {
  const { company } = useCompany();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const rows: T[] = [];
      let cursor: string | null | undefined;
      do {
        const page: Page<T> = await api<Page<T>>(path, { companyId: company.id, query: { ...query, cursor: cursor ?? undefined, limit: 200 } });
        rows.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && rows.length < maxRows);
      downloadText(filename, toCsv(columns, rows));
      toast.success(`Exported ${rows.length} row${rows.length === 1 ? '' : 's'}`, cursor ? `Stopped at ${maxRows} rows; narrow the filters to export the rest.` : undefined);
    } catch (e) {
      toast.error('Export failed', e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" className={phoneHidden} onClick={() => void run()} loading={busy}>
        {!busy && <Download className="size-4" aria-hidden />} Export CSV
      </Button>
      <ActionMenu
        className="order-last sm:hidden"
        groups={[[{ label: 'Export CSV', icon: Download, disabled: busy, description: busy ? 'Exporting…' : 'Every row matching the filters', onSelect: () => void run() }]]}
      />
    </>
  );
}
