'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Download, FileDown, Info, Printer } from 'lucide-react';
import { Button, LinkButton, buttonClass } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { ActionMenu, phoneHidden } from '@/components/ui/action-menu';
import { Field, Input, Select } from '@/components/ui/input';
import { useCompany } from '@/components/company-context';
import { HelpTip } from '@/components/ui/term';
import type { ReportBasis } from '@/lib/queries/reports';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Date helpers (local calendar dates as YYYY-MM-DD strings; no arithmetic on money)
// ---------------------------------------------------------------------------
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `m` is zero-based and may be out of range (-1 is December of the previous year). */
export function iso(y: number, m: number, d: number): string {
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
/** Days in month `m` (zero-based, may be out of range). */
export function lastDay(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}
export function todayLocalIso(): string {
  const n = new Date();
  return iso(n.getFullYear(), n.getMonth(), n.getDate());
}
/** Add days to a YYYY-MM-DD string (UTC arithmetic, calendar-safe). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
/** First day of the fiscal year that contains `asOf` (mirrors the server). */
export function fiscalYearStart(asOf: string, startMonth: number): string {
  const y = Number(asOf.slice(0, 4));
  const m = Number(asOf.slice(5, 7));
  const fyYear = m >= startMonth ? y : y - 1;
  return `${fyYear}-${String(startMonth).padStart(2, '0')}-01`;
}
/** Last day of the month `delta` months after the month of `n` (0 = this month). */
function monthEnd(n: Date, delta: number): string {
  const y = n.getFullYear();
  const m = n.getMonth() + delta;
  return iso(y, m, lastDay(y, m));
}
function monthStart(n: Date, delta: number): string {
  return iso(n.getFullYear(), n.getMonth() + delta, 1);
}

export type PresetKey =
  | 'this-month'
  | 'last-month'
  | 'this-quarter'
  | 'last-quarter'
  | 'year-to-date'
  | 'this-year'
  | 'last-year'
  | 'this-fiscal-year'
  | 'last-fiscal-year';

export interface DatePresetDef {
  key: PresetKey;
  label: string;
  /** `fyStartMonth` is 1–12 (company.fiscalYearStartMonth); only fiscal presets use it. */
  range: (now: Date, fyStartMonth?: number) => { from: string; to: string };
  fiscal?: boolean;
}

/** Report date presets. `PRESETS[0]` (this month) is the default range on every report. */
export const PRESETS: DatePresetDef[] = [
  { key: 'this-month', label: 'This month', range: (n) => ({ from: monthStart(n, 0), to: monthEnd(n, 0) }) },
  { key: 'last-month', label: 'Last month', range: (n) => ({ from: monthStart(n, -1), to: monthEnd(n, -1) }) },
  {
    key: 'this-quarter',
    label: 'This quarter',
    range: (n) => {
      const q = Math.floor(n.getMonth() / 3) * 3 - n.getMonth();
      return { from: monthStart(n, q), to: monthEnd(n, q + 2) };
    },
  },
  {
    key: 'last-quarter',
    label: 'Last quarter',
    range: (n) => {
      const q = Math.floor(n.getMonth() / 3) * 3 - n.getMonth() - 3;
      return { from: monthStart(n, q), to: monthEnd(n, q + 2) };
    },
  },
  { key: 'year-to-date', label: 'Year to date', range: (n) => ({ from: iso(n.getFullYear(), 0, 1), to: iso(n.getFullYear(), n.getMonth(), n.getDate()) }) },
  { key: 'this-year', label: 'This year', range: (n) => ({ from: iso(n.getFullYear(), 0, 1), to: iso(n.getFullYear(), 11, 31) }) },
  { key: 'last-year', label: 'Last year', range: (n) => ({ from: iso(n.getFullYear() - 1, 0, 1), to: iso(n.getFullYear() - 1, 11, 31) }) },
  {
    key: 'this-fiscal-year',
    label: 'This fiscal year',
    fiscal: true,
    range: (n, fy = 1) => {
      const from = fiscalYearStart(iso(n.getFullYear(), n.getMonth(), n.getDate()), fy);
      return { from, to: addDays(`${Number(from.slice(0, 4)) + 1}${from.slice(4)}`, -1) };
    },
  },
  {
    key: 'last-fiscal-year',
    label: 'Last fiscal year',
    fiscal: true,
    range: (n, fy = 1) => {
      const thisStart = fiscalYearStart(iso(n.getFullYear(), n.getMonth(), n.getDate()), fy);
      return { from: `${Number(thisStart.slice(0, 4)) - 1}${thisStart.slice(4)}`, to: addDays(thisStart, -1) };
    },
  },
];

export const DEFAULT_PRESET: PresetKey = 'this-month';

/** Quick picks for a single as-of date: today and the most recent month, quarter and year ends. */
export function asOfPresets(now = new Date()): { label: string; value: string }[] {
  const qStart = Math.floor(now.getMonth() / 3) * 3 - now.getMonth();
  return [
    { label: 'Today', value: iso(now.getFullYear(), now.getMonth(), now.getDate()) },
    { label: 'End of last month', value: monthEnd(now, -1) },
    { label: 'End of last quarter', value: monthEnd(now, qStart - 1) },
    { label: 'End of last year', value: iso(now.getFullYear() - 1, 11, 31) },
  ];
}

/** Presets offered for a company: fiscal-year presets only when the fiscal year is not the calendar year. */
export function presetsFor(fyStartMonth: number): DatePresetDef[] {
  return PRESETS.filter((p) => !p.fiscal || fyStartMonth !== 1);
}

export function defaultRange(fyStartMonth = 1, now = new Date()): { from: string; to: string } {
  return PRESETS.find((p) => p.key === DEFAULT_PRESET)!.range(now, fyStartMonth);
}

// ---------------------------------------------------------------------------
// Remembered range and basis (sessionStorage, per company): the range you pick
// on one report is where the next report opens.
// ---------------------------------------------------------------------------
export interface StoredReportState {
  from?: string;
  to?: string;
  basis?: ReportBasis;
}

const storageKey = (companyId: string) => `eb.report-range.${companyId}`;
const listeners = new Set<() => void>();

function readStoredRaw(companyId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(companyId));
  } catch {
    return null;
  }
}

function parseStored(raw: string | null): StoredReportState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredReportState;
    const out: StoredReportState = {};
    if (typeof v.from === 'string' && DATE_RE.test(v.from) && typeof v.to === 'string' && DATE_RE.test(v.to)) {
      out.from = v.from;
      out.to = v.to;
    }
    if (v.basis === 'cash' || v.basis === 'accrual') out.basis = v.basis;
    return out;
  } catch {
    return null;
  }
}

export function writeStoredReportState(companyId: string, patch: StoredReportState) {
  try {
    const cur = parseStored(readStoredRaw(companyId)) ?? {};
    const next = JSON.stringify({ ...cur, ...patch });
    if (next === readStoredRaw(companyId)) return;
    window.sessionStorage.setItem(storageKey(companyId), next);
    listeners.forEach((l) => l());
  } catch {
    // Storage disabled (private mode): the range simply is not remembered.
  }
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const noopSubscribe = () => () => {};

/** False during the server render and hydration, true afterwards. */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** The remembered range/basis for this company (null on the server and before hydration). */
export function useStoredReportState(): StoredReportState | null {
  const { company } = useCompany();
  const raw = React.useSyncExternalStore(
    subscribe,
    () => readStoredRaw(company.id),
    () => null,
  );
  return React.useMemo(() => parseStored(raw), [raw]);
}

/** Query string (`from`, `to`, `basis`) that carries the remembered range into a report link. */
export function rangeQuery(state: StoredReportState | null | undefined, opts: { basis?: boolean } = {}): string {
  if (!state) return '';
  const sp = new URLSearchParams();
  if (state.from && state.to) {
    sp.set('from', state.from);
    sp.set('to', state.to);
  }
  if (opts.basis && state.basis) sp.set('basis', state.basis);
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------------------
// URL state: every report is driven by its search params so views are linkable.
// ---------------------------------------------------------------------------
export function useUrlState(basePath: string) {
  const router = useRouter();
  const sp = useSearchParams();
  const set = React.useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(qs ? `${basePath}?${qs}` : basePath);
    },
    [router, sp, basePath],
  );
  return { sp, set };
}

export function dateParam(sp: URLSearchParams, key: string, fallback: string): string {
  const v = sp.get(key) ?? '';
  return DATE_RE.test(v) ? v : fallback;
}

/**
 * Range (and basis) for a period report: the URL wins, then the range last used
 * on any report in this tab, then the shared default (this month). The basis
 * falls back to how the company reports taxes (`taxBasis`), then accrual. The result is
 * remembered for the next report. `ready` is false until the remembered range
 * can be read, so queries do not fetch the default range first.
 */
export function useReportParams(basePath: string, opts: { basis?: boolean; defaultBasis?: ReportBasis } = {}) {
  const { company } = useCompany();
  const { sp, set } = useUrlState(basePath);
  const hydrated = useHydrated();
  const stored = useStoredReportState();
  const fallback = React.useMemo(() => defaultRange(company.fiscalYearStartMonth), [company.fiscalYearStartMonth]);
  const urlFrom = sp.get('from') ?? '';
  const urlTo = sp.get('to') ?? '';
  const urlHasRange = DATE_RE.test(urlFrom) && DATE_RE.test(urlTo);
  const urlBasis = sp.get('basis');
  const from = urlHasRange ? urlFrom : (stored?.from ?? fallback.from);
  const to = urlHasRange ? urlTo : (stored?.to ?? fallback.to);
  const basis: ReportBasis = urlBasis === 'cash' || urlBasis === 'accrual' ? urlBasis : (stored?.basis ?? opts.defaultBasis ?? company.taxBasis ?? 'accrual');
  const ready = hydrated || (urlHasRange && (!opts.basis || urlBasis === 'cash' || urlBasis === 'accrual'));
  const rangeValid = from <= to;

  React.useEffect(() => {
    if (!hydrated || !rangeValid) return;
    writeStoredReportState(company.id, opts.basis ? { from, to, basis } : { from, to });
  }, [hydrated, rangeValid, company.id, from, to, basis, opts.basis]);

  /** Change the range: both ends go into the URL so the view stays linkable. */
  const setRange = React.useCallback((r: { from?: string; to?: string }) => set({ from: r.from ?? from, to: r.to ?? to }), [set, from, to]);
  const setBasis = React.useCallback((b: ReportBasis) => set({ from, to, basis: b }), [set, from, to]);

  return { sp, set, from, to, basis, ready, rangeValid, setRange, setBasis };
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------
/** Compact period picker: a preset menu plus from/to dates. Picking dates by hand shows "Custom". */
export function DateRangeControls({ from, to, onChange }: { from: string; to: string; onChange: (range: { from?: string; to?: string }) => void }) {
  const { company } = useCompany();
  const fy = company.fiscalYearStartMonth;
  const presets = presetsFor(fy);
  const now = React.useMemo(() => new Date(), []);
  const activePreset =
    presets.find((p) => {
      const r = p.range(now, fy);
      return r.from === from && r.to === to;
    })?.key ?? 'custom';
  return (
    <>
      <Field label="Period" htmlFor="period">
        <Select
          id="period"
          value={activePreset}
          onChange={(e) => {
            const p = presets.find((x) => x.key === e.target.value);
            if (p) onChange(p.range(new Date(), fy));
          }}
          className="min-w-40"
        >
          {presets.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
          <option value="custom" disabled={activePreset !== 'custom'}>
            Custom
          </option>
        </Select>
      </Field>
      <Field label="From" htmlFor="from">
        <Input id="from" type="date" value={from} onChange={(e) => e.target.value && onChange({ from: e.target.value })} />
      </Field>
      <Field label="To" htmlFor="to">
        <Input id="to" type="date" value={to} onChange={(e) => e.target.value && onChange({ to: e.target.value })} />
      </Field>
    </>
  );
}

/**
 * Cash / accrual switch with a plain explanation one tap away. Cash comes first:
 * it is how most owners file and the one they expect.
 */
export function BasisToggle({ basis, onChange }: { basis: ReportBasis; onChange: (b: ReportBasis) => void }) {
  const labelId = React.useId();
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-sm font-medium text-stone-700">
        <span id={labelId}>Basis</span>
        <HelpTip id="report-basis" className="-my-1 size-5" label="What does basis mean?" />
      </div>
      <div role="group" aria-labelledby={labelId} className="inline-flex rounded-md border border-stone-300 shadow-sm">
      {(['cash', 'accrual'] as const).map((b, i) => (
        <button
          key={b}
          type="button"
          aria-pressed={basis === b}
          onClick={() => onChange(b)}
          className={cn(
            'h-9 px-4 text-sm font-medium transition-colors',
            i === 0 ? 'rounded-l-md' : 'rounded-r-md border-l border-stone-300',
            basis === b ? 'bg-brand-600 text-white' : 'bg-white text-stone-700 hover:bg-stone-50',
          )}
        >
          {b === 'accrual' ? 'Accrual' : 'Cash'}
        </button>
      ))}
      </div>
    </div>
  );
}

/** Card holding a report's filters; hidden when printing. */
export function ReportFilters({ children }: { children: React.ReactNode }) {
  return (
    <Card className="mb-4 print:hidden">
      <div className="flex flex-wrap items-end gap-3 p-3">{children}</div>
    </Card>
  );
}

/** Small inline indicator while a report refetches behind kept placeholder data. */
export function UpdatingIndicator({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="inline-flex items-center gap-2 text-sm text-stone-500" role="status" aria-live="polite">
      <span className="size-4 animate-spin rounded-full border-2 border-stone-300 border-t-brand-600" aria-hidden />
      Updating…
    </span>
  );
}

/** Download link to the server-generated CSV (`format=csv`); rows match the JSON exactly. */
export function CsvLink({ href, disabled }: { href: string; disabled?: boolean }) {
  return (
    <a
      href={href}
      download
      data-testid="csv-link"
      aria-disabled={disabled || undefined}
      className={buttonClass('secondary', 'md', cn(phoneHidden, disabled && 'pointer-events-none opacity-50'))}
    >
      <Download className="size-4" aria-hidden /> Download CSV
    </a>
  );
}

/** Server-rendered PDF of the report with the same parameters (company, period and basis on every page). */
export function PdfLink({ href, disabled }: { href: string; disabled?: boolean }) {
  return (
    <a
      href={href}
      download
      data-testid="pdf-link"
      aria-disabled={disabled || undefined}
      className={buttonClass('secondary', 'md', cn(phoneHidden, disabled && 'pointer-events-none opacity-50'))}
    >
      <FileDown className="size-4" aria-hidden /> Download PDF
    </a>
  );
}

export function PrintButton({ disabled }: { disabled?: boolean }) {
  return (
    <Button variant="secondary" className={phoneHidden} onClick={() => window.print()} disabled={disabled}>
      <Printer className="size-4" aria-hidden /> Print
    </Button>
  );
}

/** Start a file download from a URL, as the `download` links do. */
function downloadFrom(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Header actions shared by every report: back to the index (carrying the
 * remembered range), Print, Download PDF and Download CSV. Hidden when printing.
 * The PDF link follows `csvDisabled` unless `pdfDisabled` is given. On phones,
 * Print and the downloads move into a "More actions" menu.
 */
export function ReportActions({
  csvHref,
  csvDisabled,
  pdfHref,
  pdfDisabled,
  children,
}: {
  csvHref?: string;
  csvDisabled?: boolean;
  pdfHref?: string;
  pdfDisabled?: boolean;
  children?: React.ReactNode;
}) {
  const stored = useStoredReportState();
  return (
    <div className="flex flex-wrap items-center gap-2 print:hidden">
      <LinkButton href={`/reports${rangeQuery(stored, { basis: true })}`} variant="secondary">
        All reports
      </LinkButton>
      {children}
      <PrintButton />
      {pdfHref !== undefined && <PdfLink href={pdfHref} disabled={pdfDisabled ?? csvDisabled} />}
      {csvHref !== undefined && <CsvLink href={csvHref} disabled={csvDisabled} />}
      <ActionMenu
        className="sm:hidden"
        groups={[
          [
            { label: 'Print', icon: Printer, onSelect: () => window.print() },
            pdfHref !== undefined && { label: 'Download PDF', icon: FileDown, disabled: pdfDisabled ?? csvDisabled, onSelect: () => downloadFrom(pdfHref) },
            csvHref !== undefined && { label: 'Download CSV', icon: Download, disabled: csvDisabled, onSelect: () => downloadFrom(csvHref) },
          ],
        ]}
      />
    </div>
  );
}

/** Report description: the server's `note` (states the basis) once loaded. */
export function ReportNote({ note, fallback, testId = 'report-note' }: { note: string | undefined; fallback: string; testId?: string }) {
  return note ? <span data-testid={testId}>{note}</span> : <>{fallback}</>;
}

/** Classes for the card that holds a printed report: flat, rows kept whole, header repeated on every page. */
export const PRINT_REPORT = 'print:border-0 print:shadow-none print:[&_thead]:static print:[&_thead]:table-header-group print:[&_tr]:break-inside-avoid';

/** Placeholder with the shape of a report while its first page loads. */
export function ReportSkeleton({ rows = 8, label = 'Loading report' }: { rows?: number; label?: string }) {
  return (
    <Card role="status" aria-busy="true" aria-live="polite" data-testid="report-skeleton">
      <span className="sr-only">{label}</span>
      <CardBody className="border-b border-stone-200">
        <div className="h-4 w-64 max-w-full animate-pulse rounded-md bg-stone-200" aria-hidden />
      </CardBody>
      <div className="divide-y divide-stone-100" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-3 py-3">
            <div className="h-3 w-12 animate-pulse rounded-md bg-stone-100" />
            <div className={cn('h-3 animate-pulse rounded-md bg-stone-100', i % 3 === 0 ? 'w-48' : i % 3 === 1 ? 'w-64' : 'w-40')} />
            <div className="ml-auto h-3 w-20 animate-pulse rounded-md bg-stone-100" />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Drill-down target for an account line: its general ledger for the report's range. */
export function glHref(accountId: string, from: string, to: string): string {
  return `/reports/general-ledger?accountId=${encodeURIComponent(accountId)}&from=${from}&to=${to}`;
}

/** Account name linking to its general ledger. */
export function AccountLink({ accountId, from, to, children }: { accountId: string; from: string; to: string; children: React.ReactNode }) {
  return (
    <Link href={glHref(accountId, from, to)} className="text-brand-700 hover:underline print:text-stone-900 print:no-underline">
      {children}
    </Link>
  );
}

/** Shown on cash-basis reports: the drill-down general ledger lists accrual postings. */
export function CashLedgerNote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs text-stone-500 print:hidden" data-testid="cash-gl-note">
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      Each category opens its full history, which dates invoices and bills when they were issued, so dates there can differ from this cash view.
    </p>
  );
}

/** Highlight negative amounts in totals. */
export function negativeClass(v: string | undefined): string | undefined {
  return v?.startsWith('-') ? 'text-red-700' : undefined;
}
