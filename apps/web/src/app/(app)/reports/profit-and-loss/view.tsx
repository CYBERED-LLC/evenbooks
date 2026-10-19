'use client';
import * as React from 'react';
import { Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { reportCsvUrl, reportPdfUrl, useProfitAndLoss } from '@/lib/queries/reports';
import { formatDate, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { cn } from '@/lib/utils';
import { Term } from '@/components/ui/term';
import { PendingReviewBanner } from '@/components/pending-review-banner';
import {
  BasisToggle,
  CashLedgerNote,
  DateRangeControls,
  PRINT_REPORT,
  ReportActions,
  ReportFilters,
  ReportNote,
  ReportSkeleton,
  UpdatingIndicator,
  useReportParams,
} from '../report-controls';
import { CompareSelect, compareParam, comparisonRange, mergeLines } from '../compare';
import { AccountLineRow, CompareCells, CompareHeads, NoneRow, SectionHeader, TotalRow } from '../report-table';

export function ProfitAndLossView() {
  const { company } = useCompany();
  const { sp, set, from, to, basis, ready, rangeValid, setRange, setBasis } = useReportParams('/reports/profit-and-loss', { basis: true });
  const compare = compareParam(sp);
  const prior = comparisonRange(from, to, compare);

  const q = useProfitAndLoss({ from, to, basis }, ready && rangeValid);
  const pq = useProfitAndLoss({ from: prior?.from ?? from, to: prior?.to ?? to, basis }, ready && rangeValid && !!prior);
  const priorData = prior ? pq.data : undefined;
  const comparing = !!prior && !!priorData;
  const cur = q.data?.currency ?? company.baseCurrency;

  const income = React.useMemo(() => (q.data ? mergeLines(q.data.income, priorData?.income) : []), [q.data, priorData]);
  const expenses = React.useMemo(() => (q.data ? mergeLines(q.data.expenses, priorData?.expenses) : []), [q.data, priorData]);
  const cols = 3 + (comparing ? 3 : 0);
  const priorTitle = prior ? `${formatDate(prior.from)} – ${formatDate(prior.to)}` : undefined;

  return (
    <>
      <PageHeader
        title="Profit & Loss"
        description={<ReportNote note={q.data?.note} fallback="Am I making money? Income minus expenses for the period." testId="pnl-note" />}
        actions={
          <ReportActions
            csvHref={reportCsvUrl('/api/reports/profit-and-loss', { from, to, basis })}
            pdfHref={reportPdfUrl('/api/reports/profit-and-loss', { from, to, basis, compareFrom: prior?.from, compareTo: prior?.to })}
            csvDisabled={!rangeValid}
          />
        }
      />

      <ReportFilters>
        <DateRangeControls from={from} to={to} onChange={setRange} />
        <BasisToggle basis={basis} onChange={setBasis} />
        <CompareSelect value={compare} onChange={(m) => set({ from, to, compare: m === 'none' ? null : m })} />
        <UpdatingIndicator show={(q.isFetching && !!q.data) || (!!prior && pq.isFetching)} />
      </ReportFilters>

      {rangeValid && ready && <PendingReviewBanner from={from} to={to} />}
      {!rangeValid && <ErrorNotice error={new Error('The "from" date must be on or before the "to" date.')} />}
      {rangeValid && (!ready || q.isPending) && <ReportSkeleton />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {prior && pq.isError && <ErrorNotice error={pq.error} onRetry={() => pq.refetch()} />}
      {q.data && (
        <Card className={cn(PRINT_REPORT, q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || q.isFetching}>
          <CardBody className="border-b border-stone-200">
            <p className="text-sm text-stone-600">
              <span className="font-medium text-stone-900">{company.name}</span> · {formatDate(q.data.from)} – {formatDate(q.data.to)} · {q.data.basis === 'cash' ? 'Cash' : 'Accrual'} basis
              {comparing && priorTitle && <span data-testid="compare-caption"> · Compared with {priorTitle}</span>}
            </p>
            <CashLedgerNote show={q.data.basis === 'cash'} />
          </CardBody>
          {q.data.income.length === 0 && q.data.expenses.length === 0 && income.length === 0 && expenses.length === 0 ? (
            <CardBody>
              <EmptyState title="No activity in this period" description="Nothing was recorded between these dates on this basis." />
            </CardBody>
          ) : (
            <Table aria-label="Profit and loss" stickyHeader>
              <THead>
                <TR>
                  <TH className="w-24">Code</TH>
                  <TH>Account</TH>
                  <TH numeric>Amount</TH>
                  <CompareHeads on={comparing} priorTitle={priorTitle} />
                </TR>
              </THead>
              <TBody>
                <SectionHeader title="Income" colSpan={cols} />
                {income.length === 0 && <NoneRow colSpan={cols} />}
                {income.map((l) => (
                  <AccountLineRow key={l.accountId} line={l} currency={cur} from={from} to={to} priorFrom={prior?.from} priorTo={prior?.to} compare={comparing} testId="pnl-income" />
                ))}
                <TotalRow label="Total income" labelSpan={2} amount={q.data.totalIncome} prior={priorData?.totalIncome} compare={comparing} currency={cur} testId="pnl-income-total" highlightNegative={false} />

                <SectionHeader title="Expenses" colSpan={cols} />
                {expenses.length === 0 && <NoneRow colSpan={cols} />}
                {expenses.map((l) => (
                  <AccountLineRow key={l.accountId} line={l} currency={cur} from={from} to={to} priorFrom={prior?.from} priorTo={prior?.to} compare={comparing} testId="pnl-expense" />
                ))}
                <TotalRow label="Total expenses" labelSpan={2} amount={q.data.totalExpenses} prior={priorData?.totalExpenses} compare={comparing} currency={cur} testId="pnl-expense-total" highlightNegative={false} />

                <TotalRow label={<Term id="profit">Profit</Term>} labelSpan={2} amount={q.data.netIncome} prior={priorData?.netIncome} compare={comparing} currency={cur} testId="pnl-net-income" className="bg-stone-50" />
                {q.data.basis === 'cash' && q.data.salesTaxCollected !== undefined && (
                  <>
                    <SectionHeader title="Not income" colSpan={cols} className="pt-4" />
                    <TR>
                      <TD />
                      <TD className="text-stone-600">Sales tax collected</TD>
                      <TD numeric className="text-stone-600" data-testid="pnl-sales-tax">
                        {formatMoney(q.data.salesTaxCollected, cur)}
                      </TD>
                      <CompareCells on={comparing} current={q.data.salesTaxCollected} prior={priorData?.salesTaxCollected ?? '0.00'} currency={cur} />
                    </TR>
                  </>
                )}
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
