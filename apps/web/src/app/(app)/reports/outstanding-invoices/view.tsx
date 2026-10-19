'use client';
import * as React from 'react';
import Link from 'next/link';
import { Badge, Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { type AgingBucket, type OutstandingInvoiceItem, reportCsvUrl, reportPdfUrl, useOutstandingInvoices } from '@/lib/queries/reports';
import { sumDecimals } from '@/lib/decimal';
import { formatDate, formatMoney } from '@/lib/format';
import { useCompany, useToday } from '@/components/company-context';
import { cn } from '@/lib/utils';
import { PRINT_REPORT, ReportActions, ReportFilters, ReportNote, ReportSkeleton, UpdatingIndicator, asOfPresets, dateParam, useUrlState } from '../report-controls';

export const AGING_BUCKETS: { key: AgingBucket; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30 days' },
  { key: 'd31_60', label: '31–60 days' },
  { key: 'd61_90', label: '61–90 days' },
  { key: 'd90plus', label: '90+ days' },
];
const BUCKET_KEYS = new Set<string>(AGING_BUCKETS.map((b) => b.key));

export function OutstandingInvoicesView() {
  const { company } = useCompany();
  const { sp, set } = useUrlState('/reports/outstanding-invoices');
  const today = useToday();
  // Today plus recent month and quarter ends (year end is not a receivables cut-off people ask for here).
  const presets = React.useMemo(() => asOfPresets().slice(0, 3), []);
  const asOf = dateParam(sp, 'asOf', today);
  const bucketParam = sp.get('bucket') ?? '';
  const bucket = BUCKET_KEYS.has(bucketParam) ? (bucketParam as AgingBucket) : null;
  const byCustomer = sp.get('group') === 'customer';

  const q = useOutstandingInvoices({ asOf });
  const cur = q.data?.currency ?? company.baseCurrency;
  const items = React.useMemo(() => (q.data?.items ?? []).filter((i) => !bucket || i.bucket === bucket), [q.data, bucket]);
  const overdueCount = items.filter((i) => i.daysOverdue > 0).length;
  const shownTotal = bucket && q.data ? q.data.aging[bucket] : (q.data?.total ?? '0.00');
  const groups = React.useMemo(() => {
    if (!byCustomer) return null;
    const map = new Map<string, { contactId: string; contactName: string; items: OutstandingInvoiceItem[] }>();
    for (const i of items) {
      const g = map.get(i.contactId) ?? { contactId: i.contactId, contactName: i.contactName, items: [] };
      g.items.push(i);
      map.set(i.contactId, g);
    }
    return [...map.values()].sort((a, b) => a.contactName.localeCompare(b.contactName));
  }, [byCustomer, items]);

  const bucketLabel = bucket ? AGING_BUCKETS.find((b) => b.key === bucket)!.label : null;

  return (
    <>
      <PageHeader
        title="Outstanding invoices"
        description={<ReportNote note={q.data?.note} fallback="Who owes you, and how late they are." />}
        actions={
          <ReportActions
            csvHref={reportCsvUrl('/api/reports/outstanding-invoices', { asOf })}
            pdfHref={reportPdfUrl('/api/reports/outstanding-invoices', { asOf, bucket, group: byCustomer ? 'customer' : undefined })}
          />
        }
      />

      <ReportFilters>
        <Field label="As of" htmlFor="asOf">
          <DateInput id="asOf" value={asOf} presets={presets} onChange={(v) => v && set({ asOf: v })} />
        </Field>
        <div role="group" aria-label="Group rows" className="inline-flex rounded-md border border-stone-300 shadow-sm">
          {(
            [
              ['invoice', 'By invoice'],
              ['customer', 'By customer'],
            ] as const
          ).map(([k, label], i) => {
            const active = (k === 'customer') === byCustomer;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => set({ group: k === 'customer' ? 'customer' : null })}
                className={cn(
                  'h-9 px-4 text-sm font-medium transition-colors',
                  i === 0 ? 'rounded-l-md' : 'rounded-r-md border-l border-stone-300',
                  active ? 'bg-brand-600 text-white' : 'bg-white text-stone-700 hover:bg-stone-50',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <UpdatingIndicator show={q.isFetching && !!q.data} />
      </ReportFilters>

      {q.isPending && <ReportSkeleton />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className={cn(q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || q.isFetching}>
          <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6" role="group" aria-label="Aging summary: choose a bucket to filter the table">
            <Tile
              label="Total outstanding"
              value={formatMoney(q.data.total, cur)}
              emphasis
              testId="oi-total"
              hint={`${q.data.items.length} ${q.data.items.length === 1 ? 'invoice' : 'invoices'}`}
              pressed={!bucket}
              onClick={() => set({ bucket: null })}
            />
            {AGING_BUCKETS.map((b) => {
              const n = q.data!.items.filter((i) => i.bucket === b.key).length;
              return (
                <Tile
                  key={b.key}
                  label={b.label}
                  value={formatMoney(q.data!.aging[b.key], cur)}
                  overdue={b.key !== 'current' && q.data!.aging[b.key] !== '0.00'}
                  testId={`oi-${b.key}`}
                  hint={`${n} ${n === 1 ? 'invoice' : 'invoices'}`}
                  pressed={bucket === b.key}
                  onClick={() => set({ bucket: bucket === b.key ? null : b.key })}
                />
              );
            })}
          </div>

          <Card className={PRINT_REPORT}>
            <CardBody className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200">
              <p className="text-sm text-stone-600">
                <span className="font-medium text-stone-900">{company.name}</span> · As of {formatDate(q.data.asOf)}
                {bucketLabel && <span data-testid="oi-filter"> · {bucketLabel} only</span>}
              </p>
              <div className="flex items-center gap-2">
                {bucket && (
                  <Button variant="ghost" size="sm" onClick={() => set({ bucket: null })} className="print:hidden">
                    Show all
                  </Button>
                )}
                {overdueCount > 0 && (
                  <span data-testid="oi-overdue-count">
                    <Badge tone="red">{overdueCount} overdue</Badge>
                  </span>
                )}
              </div>
            </CardBody>
            {items.length === 0 ? (
              <CardBody>
                {bucket ? (
                  <EmptyState title={`Nothing in ${bucketLabel}`} description="No open invoice falls in this aging bucket." />
                ) : (
                  <EmptyState title="Nothing outstanding" description="Every issued invoice dated on or before this day has been paid or credited." />
                )}
              </CardBody>
            ) : (
              <Table aria-label="Outstanding invoices" stickyHeader>
                <THead>
                  <TR>
                    <TH>Invoice</TH>
                    <TH>Customer</TH>
                    <TH className="hidden md:table-cell">Issued</TH>
                    <TH>Due</TH>
                    <TH numeric className="hidden lg:table-cell">
                      Total
                    </TH>
                    <TH numeric>Balance due</TH>
                    <TH numeric className="w-28">
                      Days overdue
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {groups
                    ? groups.map((g) => (
                        <React.Fragment key={g.contactId}>
                          <TR className="bg-stone-50/70 hover:bg-stone-50/70" data-testid="oi-group">
                            <TD colSpan={7} className="font-semibold text-stone-900">
                              <Link href={`/contacts/${g.contactId}`} className="text-brand-700 hover:underline print:text-stone-900">
                                {g.contactName}
                              </Link>
                            </TD>
                          </TR>
                          {g.items.map((i) => (
                            <InvoiceRow key={i.id} i={i} currency={cur} />
                          ))}
                          <TR className="font-semibold hover:bg-transparent" data-testid="oi-subtotal">
                            <TD colSpan={2} className="text-stone-700">
                              {g.contactName} subtotal
                            </TD>
                            <TD className="hidden md:table-cell" />
                            <TD />
                            <TD numeric className="hidden lg:table-cell">
                              {formatMoney(sumDecimals(g.items.map((i) => i.total)), cur)}
                            </TD>
                            <TD numeric>{formatMoney(sumDecimals(g.items.map((i) => i.balanceDue)), cur)}</TD>
                            <TD />
                          </TR>
                        </React.Fragment>
                      ))
                    : items.map((i) => <InvoiceRow key={i.id} i={i} currency={cur} />)}
                  <TR className="bg-stone-50 font-semibold hover:bg-stone-50">
                    <TD colSpan={2}>Total</TD>
                    <TD className="hidden md:table-cell" />
                    <TD />
                    <TD numeric className="hidden lg:table-cell">
                      {formatMoney(sumDecimals(items.map((i) => i.total)), cur)}
                    </TD>
                    <TD numeric data-testid="oi-table-total">
                      {formatMoney(shownTotal, cur)}
                    </TD>
                    <TD />
                  </TR>
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function InvoiceRow({ i, currency }: { i: OutstandingInvoiceItem; currency: string }) {
  const overdue = i.daysOverdue > 0;
  return (
    <TR href={`/invoices/${i.id}`} className={cn(overdue && 'bg-red-50/70 hover:bg-red-50')} data-testid="oi-row" data-overdue={overdue || undefined} data-bucket={i.bucket}>
      <TD>
        <Link href={`/invoices/${i.id}`} className="font-medium text-brand-700 hover:underline print:text-stone-900">
          {i.number}
        </Link>
      </TD>
      <TD>
        <Link href={`/contacts/${i.contactId}`} className="text-stone-800 hover:text-brand-700 hover:underline">
          {i.contactName}
        </Link>
      </TD>
      <TD className="hidden text-stone-600 md:table-cell">{formatDate(i.issueDate)}</TD>
      <TD className={cn(overdue && 'font-medium text-red-800')}>{formatDate(i.dueDate)}</TD>
      <TD numeric className="hidden text-stone-600 lg:table-cell">
        {formatMoney(i.total, currency)}
      </TD>
      <TD numeric className={cn(overdue && 'font-semibold text-red-800')}>
        {formatMoney(i.balanceDue, currency)}
      </TD>
      <TD numeric>{overdue ? <Badge tone="red">{i.daysOverdue}d</Badge> : <span className="text-stone-400">—</span>}</TD>
    </TR>
  );
}

function Tile({
  label,
  value,
  hint,
  emphasis,
  overdue,
  testId,
  pressed,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  overdue?: boolean;
  testId: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'rounded-lg border bg-white p-4 text-left shadow-sm transition-colors hover:border-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-200',
        emphasis ? 'border-brand-200 bg-brand-50/40' : overdue ? 'border-red-200' : 'border-stone-200',
        pressed && 'ring-2 ring-brand-500 print:ring-0',
      )}
    >
      <span className="block text-xs font-medium uppercase tracking-wide text-stone-500">{label}</span>
      <span className={cn('tabular mt-1 block text-xl font-semibold', overdue ? 'text-red-800' : 'text-stone-900')} data-testid={testId}>
        {value}
      </span>
      {hint && <span className="mt-0.5 block text-xs text-stone-500">{hint}</span>}
    </button>
  );
}
