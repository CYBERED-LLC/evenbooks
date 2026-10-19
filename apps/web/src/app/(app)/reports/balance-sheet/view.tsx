'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Field } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { reportCsvUrl, reportPdfUrl, useBalanceSheet } from '@/lib/queries/reports';
import { formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { sumDecimals } from '@/lib/decimal';
import { useCompany, useToday } from '@/components/company-context';
import { Term } from '@/components/ui/term';
import { PendingReviewBanner } from '@/components/pending-review-banner';
import { useAccounts } from '@/lib/queries/accounts';
import { cn } from '@/lib/utils';
import {
  PRINT_REPORT,
  ReportActions,
  ReportFilters,
  ReportNote,
  ReportSkeleton,
  UpdatingIndicator,
  asOfPresets,
  dateParam,
  fiscalYearStart,
  useUrlState,
} from '../report-controls';
import { CompareCells, CompareHeads, NoneRow, SectionHeader, TotalRow, AccountLineRow } from '../report-table';
import { CompareSelect, compareParam, comparisonAsOf, mergeLines } from '../compare';

/**
 * Accounts whose balance is normally below zero on the balance sheet: owner's
 * draws and contra accounts such as accumulated depreciation. Their negative
 * amounts are expected, so they are not shown in red.
 */
const CONTRA_NAME = /\b(accumulated (depreciation|amortization)|allowance for|draws?)\b/i;

export function BalanceSheetView() {
  const { company } = useCompany();
  const { sp, set } = useUrlState('/reports/balance-sheet');
  const today = useToday();
  const presets = React.useMemo(() => asOfPresets(), []);
  const asOf = dateParam(sp, 'asOf', today);
  const fyStart = fiscalYearStart(asOf, company.fiscalYearStartMonth);
  const compare = compareParam(sp);
  const priorAsOf = comparisonAsOf(asOf, compare);
  const priorFyStart = priorAsOf ? fiscalYearStart(priorAsOf, company.fiscalYearStartMonth) : undefined;

  const q = useBalanceSheet({ asOf });
  const pq = useBalanceSheet({ asOf: priorAsOf ?? asOf }, !!priorAsOf);
  const priorData = priorAsOf ? pq.data : undefined;
  const comparing = !!priorData;
  const cur = q.data?.currency ?? company.baseCurrency;
  const inconsistent = q.data ? !isZeroDecimal(q.data.difference) : false;
  const cols = 3 + (comparing ? 3 : 0);

  const assets = React.useMemo(() => (q.data ? mergeLines(q.data.assets, priorData?.assets) : []), [q.data, priorData]);
  const liabilities = React.useMemo(() => (q.data ? mergeLines(q.data.liabilities, priorData?.liabilities) : []), [q.data, priorData]);
  const equity = React.useMemo(() => (q.data ? mergeLines(q.data.equity, priorData?.equity) : []), [q.data, priorData]);
  const lineProps = { currency: cur, from: fyStart, to: asOf, priorFrom: priorFyStart, priorTo: priorAsOf ?? undefined, compare: comparing, testId: 'bs' };
  const accounts = useAccounts({ includeArchived: true });
  const contraIds = React.useMemo(() => new Set((accounts.data ?? []).filter((a) => a.role === 'owner_draws' || CONTRA_NAME.test(a.name)).map((a) => a.id)), [accounts.data]);
  const red = (accountId: string) => !contraIds.has(accountId);

  return (
    <>
      <PageHeader
        title="Balance sheet"
        description={<ReportNote note={q.data?.note} fallback="What the business has, what it owes, and what is left for you, on one date." />}
        actions={<ReportActions csvHref={reportCsvUrl('/api/reports/balance-sheet', { asOf })} pdfHref={reportPdfUrl('/api/reports/balance-sheet', { asOf, compareAsOf: priorAsOf })} />}
      />

      <ReportFilters>
        <Field label="As of" htmlFor="asOf">
          <DateInput id="asOf" value={asOf} presets={presets} onChange={(v) => v && set({ asOf: v })} />
        </Field>
        <CompareSelect kind="asOf" value={compare} onChange={(m) => set({ compare: m === 'none' ? null : m })} />
        <UpdatingIndicator show={(q.isFetching && !!q.data) || (!!priorAsOf && pq.isFetching)} />
      </ReportFilters>

      <PendingReviewBanner to={asOf} />

      {inconsistent && q.data && (
        <div role="alert" className="mb-4 flex items-start gap-3 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900" data-testid="bs-inconsistent">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">Your books don’t balance.</p>
            <p>
              What the business has differs from what it owes plus what is left for you by <span className="tabular font-medium">{formatMoney(q.data.difference, cur)}</span>. This should never
              happen; look at recent <Link href="/journal" className="underline">journal entries</Link> or contact support.
            </p>
          </div>
        </div>
      )}

      {q.isPending && <ReportSkeleton />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {priorAsOf && pq.isError && <ErrorNotice error={pq.error} onRetry={() => pq.refetch()} />}
      {q.data && (
        <Card className={cn(PRINT_REPORT, q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || q.isFetching}>
          <CardBody className="border-b border-stone-200">
            <p className="text-sm text-stone-600">
              <span className="font-medium text-stone-900">{company.name}</span> · As of {formatDate(q.data.asOf)} · Accrual basis
              {comparing && priorAsOf && <span data-testid="compare-caption"> · Compared with {formatDate(priorAsOf)}</span>}
            </p>
          </CardBody>
          {assets.length === 0 && liabilities.length === 0 && equity.length === 0 && isZeroDecimal(q.data.currentYearEarnings) && isZeroDecimal(q.data.retainedEarningsPriorYears) ? (
            <CardBody>
              <EmptyState title="Nothing recorded yet" description="Balances appear here once something is recorded on or before this date." />
            </CardBody>
          ) : (
            <Table aria-label="Balance sheet" stickyHeader>
              <THead>
                <TR>
                  <TH className="w-24">Code</TH>
                  <TH>Account</TH>
                  <TH numeric>Balance</TH>
                  <CompareHeads on={comparing} priorTitle={priorAsOf ? `As of ${formatDate(priorAsOf)}` : undefined} />
                </TR>
              </THead>
              <TBody>
                <SectionHeader title="Assets" intro={<Term id="assets" />} colSpan={cols} />
                {assets.length === 0 && <NoneRow colSpan={cols} />}
                {assets.map((l) => (
                  <AccountLineRow key={l.accountId} line={l} {...lineProps} highlightNegative={red(l.accountId)} />
                ))}
                <TotalRow label="Total assets" labelSpan={2} amount={q.data.totalAssets} prior={priorData?.totalAssets} compare={comparing} currency={cur} testId="bs-total-assets" />

                <SectionHeader title="Liabilities" intro={<Term id="liabilities" />} colSpan={cols} />
                {liabilities.length === 0 && <NoneRow colSpan={cols} />}
                {liabilities.map((l) => (
                  <AccountLineRow key={l.accountId} line={l} {...lineProps} highlightNegative={red(l.accountId)} />
                ))}
                <TotalRow label="Total liabilities" labelSpan={2} amount={q.data.totalLiabilities} prior={priorData?.totalLiabilities} compare={comparing} currency={cur} testId="bs-total-liabilities" />

                <SectionHeader title="Equity" intro={<Term id="equity" />} colSpan={cols} />
                {equity.map((l) => (
                  <AccountLineRow key={l.accountId} line={l} {...lineProps} highlightNegative={red(l.accountId)} />
                ))}
                <TR>
                  <TD className="font-mono text-xs text-stone-500" />
                  <TD className="text-stone-700">Profit from earlier years</TD>
                  <TD numeric className={cn(q.data.retainedEarningsPriorYears.startsWith('-') && 'text-red-700')}>
                    {formatMoney(q.data.retainedEarningsPriorYears, cur)}
                  </TD>
                  <CompareCells on={comparing} current={q.data.retainedEarningsPriorYears} prior={priorData?.retainedEarningsPriorYears ?? null} currency={cur} />
                </TR>
                <TR>
                  <TD className="font-mono text-xs text-stone-500" />
                  <TD className="text-stone-700">
                    Profit this year so far{' '}
                    <span className="text-xs text-stone-500">
                      (
                      <Link href={`/reports/profit-and-loss?from=${fyStart}&to=${asOf}&basis=accrual`} className="text-brand-700 hover:underline">
                        since {formatDate(fyStart)}
                      </Link>
                      )
                    </span>
                  </TD>
                  <TD numeric className={cn(q.data.currentYearEarnings.startsWith('-') && 'text-red-700')}>
                    {formatMoney(q.data.currentYearEarnings, cur)}
                  </TD>
                  <CompareCells on={comparing} current={q.data.currentYearEarnings} prior={priorData?.currentYearEarnings ?? null} currency={cur} />
                </TR>
                <TotalRow label="Total equity" labelSpan={2} amount={q.data.totalEquity} prior={priorData?.totalEquity} compare={comparing} currency={cur} testId="bs-total-equity" />

                <TotalRow
                  label="Total liabilities and equity"
                  labelSpan={2}
                  amount={sumDecimals([q.data.totalLiabilities, q.data.totalEquity])}
                  prior={priorData ? sumDecimals([priorData.totalLiabilities, priorData.totalEquity]) : null}
                  compare={comparing}
                  currency={cur}
                  testId="bs-total-liabilities-equity"
                  className="bg-stone-50"
                />
                {/* Always zero when the books balance, so it only shows when something is wrong. */}
                {inconsistent && (
                  <TR className="bg-red-50 font-semibold text-red-800 hover:bg-red-50">
                    <TD colSpan={2}>Difference (assets − liabilities − equity)</TD>
                    <TD numeric data-testid="bs-difference" className="text-red-800">
                      {formatMoney(q.data.difference, cur)}
                    </TD>
                    {comparing && <TD colSpan={3} />}
                  </TR>
                )}
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
