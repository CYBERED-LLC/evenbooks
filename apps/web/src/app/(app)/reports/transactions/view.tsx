'use client';
import * as React from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { ContactPicker } from '@/components/contact-picker';
import { reportCsvUrl, reportPdfUrl, transactionsQuery, useTransactionsReport } from '@/lib/queries/reports';
import { useDebounced } from '@/lib/use-debounced';
import { formatDate, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { cn } from '@/lib/utils';
import {
  DateRangeControls,
  PRINT_REPORT,
  ReportActions,
  ReportFilters,
  ReportNote,
  ReportSkeleton,
  UpdatingIndicator,
  glHref,
  useReportParams,
} from '../report-controls';
import { ReportAccountPicker } from '../report-account-picker';
import { JOURNAL_SOURCE_LABELS, journalSourceLabel } from '@/lib/queries/journal';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCE_TYPES = Object.keys(JOURNAL_SOURCE_LABELS);

export function TransactionsReportView() {
  const { company } = useCompany();
  const { sp, set, from, to, ready, rangeValid, setRange } = useReportParams('/reports/transactions');
  const accountId = UUID_RE.test(sp.get('accountId') ?? '') ? sp.get('accountId')! : '';
  const contactId = UUID_RE.test(sp.get('contactId') ?? '') ? sp.get('contactId')! : '';
  const sourceType = sp.get('sourceType') ?? '';
  const urlQ = sp.get('q') ?? '';

  // Memo search: typed locally, pushed to the URL once typing pauses.
  const [search, setSearch] = React.useState(urlQ);
  const debounced = useDebounced(search, 300);
  const [syncedQ, setSyncedQ] = React.useState(urlQ);
  const [pushedQ, setPushedQ] = React.useState(urlQ);
  if (urlQ !== syncedQ) {
    setSyncedQ(urlQ);
    // The URL changed from elsewhere (back button, a link): follow it, but never clobber what is being typed.
    if (urlQ !== pushedQ) setSearch(urlQ);
  }
  const debouncedQ = debounced.trim();
  React.useEffect(() => {
    if (debouncedQ === urlQ) return;
    setPushedQ(debouncedQ);
    set({ from, to, q: debouncedQ || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ]);

  const params = { from, to, accountId, contactId, sourceType, q: urlQ };
  const q = useTransactionsReport(params, ready && rangeValid);
  const first = q.data?.pages[0];
  const rows = React.useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data]);
  const cur = first?.currency ?? company.baseCurrency;
  const { limit: _limit, ...csvParams } = transactionsQuery(params);

  return (
    <>
      <PageHeader
        title="All activity"
        description={<ReportNote note={first?.note} fallback="Every line recorded in your books in a period, by account, customer or vendor, and where it came from." />}
        actions={<ReportActions csvHref={reportCsvUrl('/api/reports/transactions', csvParams)} pdfHref={reportPdfUrl('/api/reports/transactions', csvParams)} csvDisabled={!rangeValid} />}
      />

      <ReportFilters>
          <DateRangeControls from={from} to={to} onChange={setRange} />
          <Field label="Account" htmlFor="accountId" className="min-w-64">
            <ReportAccountPicker id="accountId" value={accountId} onChange={(id) => set({ from, to, accountId: id })} placeholder="All accounts" clearable />
          </Field>
          <div className="min-w-56">
            <ContactPicker id="contactId" label="Contact" value={contactId || null} onChange={(id) => set({ from, to, contactId: id })} clearable allowCreate={false} includeArchived />
          </div>
          <Field label="Source" htmlFor="sourceType">
            <Select id="sourceType" value={sourceType} onChange={(e) => set({ from, to, sourceType: e.target.value || null })}>
              <option value="">All sources</option>
              {SOURCE_TYPES.map((s) => (
                <option key={s} value={s}>
                  {journalSourceLabel(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Memo" htmlFor="txn-q" className="min-w-56">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
              <Input id="txn-q" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search memos…" className="pl-8" />
            </div>
          </Field>
          {(accountId || contactId || sourceType || urlQ) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch('');
                set({ from, to, accountId: null, contactId: null, sourceType: null, q: null });
              }}
            >
              Clear filters
            </Button>
          )}
          <UpdatingIndicator show={q.isFetching && !q.isFetchingNextPage && !!q.data} />
      </ReportFilters>

      {!rangeValid && <ErrorNotice error={new Error('The "from" date must be on or before the "to" date.')} />}
      {rangeValid && (!ready || q.isPending) && <ReportSkeleton />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {first && (
        <Card className={cn(PRINT_REPORT, q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || q.isFetching}>
          <CardBody className="border-b border-stone-200">
            <p className="text-sm text-stone-600">
              <span className="font-medium text-stone-900">{company.name}</span> · {formatDate(first.from)} – {formatDate(first.to)} · Accrual basis
            </p>
          </CardBody>
          {rows.length === 0 ? (
            <CardBody>
              <EmptyState title="Nothing matches" description="Widen the date range or clear a filter." />
            </CardBody>
          ) : (
            <>
              <Table aria-label="All activity" stickyHeader>
                <THead>
                  <TR>
                    <TH className="w-28">Date</TH>
                    <TH className="w-16">#</TH>
                    <TH>Memo</TH>
                    <TH>Account</TH>
                    <TH className="hidden lg:table-cell">Contact</TH>
                    <TH className="hidden md:table-cell">Source</TH>
                    <TH numeric>Debit</TH>
                    <TH numeric>Credit</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((r, i) => (
                    <TR key={`${r.entryId}-${r.accountCode}-${i}`} href={`/journal/${r.entryId}`} data-testid="txn-row">
                      <TD>{formatDate(r.date)}</TD>
                      <TD className="font-mono text-xs">{r.entryNumber ?? '—'}</TD>
                      <TD>
                        <Link href={`/journal/${r.entryId}`} className="font-medium text-brand-700 hover:underline">
                          {r.memo || '(no memo)'}
                        </Link>
                        {r.lineMemo && r.lineMemo !== r.memo && <p className="text-xs text-stone-500">{r.lineMemo}</p>}
                        <p className="text-xs text-stone-500 md:hidden">{journalSourceLabel(r.sourceType)}</p>
                      </TD>
                      <TD>
                        <Link href={glHref(r.accountId, from, to)} className="text-brand-700 hover:underline print:text-stone-900 print:no-underline" title="Open the general ledger for this account">
                          <span className="font-mono text-xs text-stone-500">{r.accountCode}</span> {r.accountName}
                        </Link>
                      </TD>
                      <TD className="hidden text-stone-600 lg:table-cell">{r.contactName ?? ''}</TD>
                      <TD className="hidden text-stone-600 md:table-cell">{journalSourceLabel(r.sourceType)}</TD>
                      <TD numeric>{r.debit !== '0.00' ? formatMoney(r.debit, cur) : ''}</TD>
                      <TD numeric>{r.credit !== '0.00' ? formatMoney(r.credit, cur) : ''}</TD>
                    </TR>
                  ))}
                  <TR className="bg-stone-50 font-semibold hover:bg-stone-50">
                    <TD colSpan={4}>
                      Total <span className="font-normal text-stone-500">· all {first.lineCount} matching {first.lineCount === 1 ? 'line' : 'lines'}</span>
                    </TD>
                    <TD className="hidden lg:table-cell" />
                    <TD className="hidden md:table-cell" />
                    <TD numeric data-testid="txn-total-debit">
                      {formatMoney(first.totalDebit, cur)}
                    </TD>
                    <TD numeric data-testid="txn-total-credit">
                      {formatMoney(first.totalCredit, cur)}
                    </TD>
                  </TR>
                </TBody>
              </Table>
              <div className="flex items-center justify-between border-t border-stone-200 px-3 py-2 text-sm print:hidden">
                <span className="text-stone-500" data-testid="txn-line-count">
                  {rows.length} of {first.lineCount} {first.lineCount === 1 ? 'line' : 'lines'}
                  {q.hasNextPage ? ' shown' : ''}
                </span>
                {q.hasNextPage && (
                  <Button variant="secondary" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                    Load more
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
      )}
    </>
  );
}
