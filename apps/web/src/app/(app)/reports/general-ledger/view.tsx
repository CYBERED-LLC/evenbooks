'use client';
import * as React from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { reportCsvUrl, reportPdfUrl, useGeneralLedger } from '@/lib/queries/reports';
import { useAccounts } from '@/lib/queries/accounts';
import { journalSourceLabel } from '@/lib/queries/journal';
import { capitalize, formatDate, formatMoney } from '@/lib/format';
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
  negativeClass,
  useReportParams,
} from '../report-controls';
import { ReportAccountPicker } from '../report-account-picker';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function GeneralLedgerView() {
  const { company } = useCompany();
  const { sp, set, from, to, ready, rangeValid, setRange } = useReportParams('/reports/general-ledger');
  const accountId = UUID_RE.test(sp.get('accountId') ?? '') ? sp.get('accountId')! : '';

  const q = useGeneralLedger({ accountId, from, to }, ready && !!accountId && rangeValid);
  const accounts = useAccounts({ includeArchived: true });
  const archived = accountId ? accounts.data?.find((a) => a.id === accountId)?.isActive === false : false;
  const first = q.data?.pages[0];
  const lines = React.useMemo(() => q.data?.pages.flatMap((p) => p.lines) ?? [], [q.data]);
  const cur = first?.currency ?? company.baseCurrency;

  return (
    <>
      <PageHeader
        title="General ledger"
        description={<ReportNote note={first?.note} fallback="For your accountant: every change to one account in a period, with a running balance." />}
        actions={
          <ReportActions
            csvHref={reportCsvUrl('/api/reports/general-ledger', { accountId, from, to })}
            pdfHref={reportPdfUrl('/api/reports/general-ledger', { accountId, from, to })}
            csvDisabled={!accountId || !rangeValid}
          />
        }
      />

      <ReportFilters>
        <Field label="Account" htmlFor="accountId" className="min-w-72">
          <ReportAccountPicker id="accountId" value={accountId} onChange={(id) => set({ from, to, accountId: id })} />
        </Field>
        <DateRangeControls from={from} to={to} onChange={setRange} />
        <UpdatingIndicator show={q.isFetching && !q.isFetchingNextPage && !!q.data} />
      </ReportFilters>

      {!rangeValid && <ErrorNotice error={new Error('The "from" date must be on or before the "to" date.')} />}
      {!accountId && rangeValid && <EmptyState title="Choose an account" description="Pick an account above to see every change to it and its running balance." />}
      {accountId && rangeValid && (!ready || q.isPending) && <ReportSkeleton />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {first && (
        <>
          {/* Whole-range figures from the server, so they are right however many lines are loaded. */}
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Ledger summary">
            <SummaryTile label="Opening balance" hint={formatDate(first.from)} value={formatMoney(first.opening, cur)} negative={first.opening.startsWith('-')} testId="gl-opening" />
            <SummaryTile label="Debits" hint="In this period" value={formatMoney(first.totalDebit, cur)} testId="gl-total-debit" />
            <SummaryTile label="Credits" hint="In this period" value={formatMoney(first.totalCredit, cur)} testId="gl-total-credit" />
            <SummaryTile label="Closing balance" hint={formatDate(first.to)} value={formatMoney(first.closing, cur)} negative={first.closing.startsWith('-')} testId="gl-closing" emphasis />
          </div>
          <Card className={cn(PRINT_REPORT, q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || q.isFetching}>
            <CardBody className="border-b border-stone-200">
              <p className="text-sm text-stone-600" data-testid="gl-account-heading">
                <span className="font-medium text-stone-900">
                  {first.code} {first.name}
                </span>{' '}
                {archived && (
                  <Badge tone="neutral" className="mr-1">
                    Archived
                  </Badge>
                )}
                · {capitalize(first.type)} · {formatDate(first.from)} – {formatDate(first.to)} · Accrual basis
              </p>
            </CardBody>
            <Table aria-label="General ledger" stickyHeader>
              <THead>
                <TR>
                  <TH className="w-28">Date</TH>
                  <TH className="w-16">#</TH>
                  <TH>Memo</TH>
                  <TH className="hidden md:table-cell">Source</TH>
                  <TH numeric>Debit</TH>
                  <TH numeric>Credit</TH>
                  <TH numeric>Balance</TH>
                </TR>
              </THead>
              <TBody>
                <TR className="bg-stone-50 text-stone-600 hover:bg-stone-50">
                  <TD>{formatDate(first.from)}</TD>
                  <TD />
                  <TD colSpan={2} className="italic">
                    Opening balance
                  </TD>
                  <TD />
                  <TD />
                  <TD numeric className={negativeClass(first.opening)}>
                    {formatMoney(first.opening, cur)}
                  </TD>
                </TR>
                {lines.length === 0 && (
                  <TR className="hover:bg-transparent">
                    <TD colSpan={7} className="py-6 text-center text-stone-400">
                      Nothing was recorded in this account in the period.
                    </TD>
                  </TR>
                )}
                {lines.map((l, i) => (
                  <TR key={`${l.entryId}-${i}`} href={`/journal/${l.entryId}`} data-testid="gl-row">
                    <TD>{formatDate(l.date)}</TD>
                    <TD className="font-mono text-xs">{l.entryNumber ?? '—'}</TD>
                    <TD>
                      <Link href={`/journal/${l.entryId}`} className="font-medium text-brand-700 hover:underline print:text-stone-900 print:no-underline">
                        {l.memo || '(no memo)'}
                      </Link>
                      {l.lineMemo && <p className="text-xs text-stone-500">{l.lineMemo}</p>}
                      <p className="text-xs text-stone-500 md:hidden">{journalSourceLabel(l.sourceType)}</p>
                    </TD>
                    <TD className="hidden text-stone-600 md:table-cell">{journalSourceLabel(l.sourceType)}</TD>
                    <TD numeric>{l.debit !== '0.00' ? formatMoney(l.debit, cur) : ''}</TD>
                    <TD numeric>{l.credit !== '0.00' ? formatMoney(l.credit, cur) : ''}</TD>
                    <TD numeric className={negativeClass(l.running)}>
                      {formatMoney(l.running, cur)}
                    </TD>
                  </TR>
                ))}
                {!q.hasNextPage && (
                  <TR className="bg-stone-50 font-semibold hover:bg-stone-50">
                    <TD>{formatDate(first.to)}</TD>
                    <TD />
                    <TD colSpan={2}>Closing balance</TD>
                    <TD numeric>{formatMoney(first.totalDebit, cur)}</TD>
                    <TD numeric>{formatMoney(first.totalCredit, cur)}</TD>
                    <TD numeric className={negativeClass(first.closing)}>
                      {formatMoney(first.closing, cur)}
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
            <div className="flex items-center justify-between border-t border-stone-200 px-3 py-2 text-sm print:hidden">
              <span className="text-stone-500">
                {lines.length} {lines.length === 1 ? 'posting' : 'postings'}
                {q.hasNextPage ? ' shown' : ''}
              </span>
              {q.hasNextPage && (
                <Button variant="secondary" size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
                  Load more
                </Button>
              )}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

function SummaryTile({ label, hint, value, negative, emphasis, testId }: { label: string; hint: string; value: string; negative?: boolean; emphasis?: boolean; testId: string }) {
  return (
    <Card className={cn(emphasis && 'border-brand-200 bg-brand-50/40')}>
      <CardBody>
        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
        <p className={cn('tabular mt-1 text-xl font-semibold', negative ? 'text-red-700' : 'text-stone-900')} data-testid={testId}>
          {value}
        </p>
        <p className="mt-0.5 text-xs text-stone-500">{hint}</p>
      </CardBody>
    </Card>
  );
}
