'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { type CategoryLine, type CategoryReport, reportCsvUrl, reportPdfUrl, useCategoryReport } from '@/lib/queries/reports';
import { useAccounts } from '@/lib/queries/accounts';
import { formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { cn } from '@/lib/utils';
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
  glHref,
  useReportParams,
} from '../report-controls';
import { CompareSelect, compareParam, comparisonRange, mergeLines } from '../compare';
import { AccountLineRow, CompareHeads, NoneRow, SectionHeader, TotalRow } from '../report-table';

type Group = CategoryReport['groups'][number];

export function CategoryReportView() {
  const { company } = useCompany();
  const { sp, set, from, to, basis, ready, rangeValid, setRange, setBasis } = useReportParams('/reports/category', { basis: true });
  const compare = compareParam(sp);
  const prior = comparisonRange(from, to, compare);

  const q = useCategoryReport({ from, to, basis }, ready && rangeValid);
  const pq = useCategoryReport({ from: prior?.from ?? from, to: prior?.to ?? to, basis }, ready && rangeValid && !!prior);
  const priorData = prior ? pq.data : undefined;
  const comparing = !!priorData;
  const accounts = useAccounts();
  const cur = q.data?.currency ?? company.baseCurrency;

  const uncatIncome = q.data && !isZeroDecimal(q.data.uncategorized.income);
  const uncatExpense = q.data && !isZeroDecimal(q.data.uncategorized.expense);
  const uncatIncomeAcct = accounts.data?.find((a) => a.role === 'uncategorized_income');
  const uncatExpenseAcct = accounts.data?.find((a) => a.role === 'uncategorized_expense');
  const uncatHref = (accountId: string | undefined) => (accountId ? glHref(accountId, from, to) : `/journal?from=${from}&to=${to}`);

  const group = (d: CategoryReport | undefined, type: Group['type']) => d?.groups.find((g) => g.type === type);
  const income = group(q.data, 'income');
  const expense = group(q.data, 'expense');
  const priorIncome = group(priorData, 'income');
  const priorExpense = group(priorData, 'expense');
  const empty = q.data && (income?.lines.length ?? 0) === 0 && (expense?.lines.length ?? 0) === 0 && (priorIncome?.lines.length ?? 0) === 0 && (priorExpense?.lines.length ?? 0) === 0;
  const cols = 4 + (comparing ? 3 : 0);
  const priorTitle = prior ? `${formatDate(prior.from)} – ${formatDate(prior.to)}` : undefined;
  const groupProps = { currency: cur, from, to, priorFrom: prior?.from, priorTo: prior?.to, compare: comparing, cols };

  return (
    <>
      <PageHeader
        title="Category report"
        description={<ReportNote note={q.data?.note} fallback="Where your money came from and went, by category." />}
        actions={
          <ReportActions
            csvHref={reportCsvUrl('/api/reports/category', { from, to, basis })}
            pdfHref={reportPdfUrl('/api/reports/category', { from, to, basis, compareFrom: prior?.from, compareTo: prior?.to })}
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

      {(uncatIncome || uncatExpense) && q.data && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 print:hidden" data-testid="category-uncategorized">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">Some money hasn’t been sorted into a category yet.</p>
            <ul className="mt-1 space-y-0.5">
              {uncatIncome && (
                <li>
                  <Link href={uncatHref(uncatIncomeAcct?.id)} className="underline">
                    Uncategorized income
                  </Link>
                  : <span className="tabular font-medium">{formatMoney(q.data.uncategorized.income, cur)}</span>
                </li>
              )}
              {uncatExpense && (
                <li>
                  <Link href={uncatHref(uncatExpenseAcct?.id)} className="underline">
                    Uncategorized expenses
                  </Link>
                  : <span className="tabular font-medium">{formatMoney(q.data.uncategorized.expense, cur)}</span>
                </li>
              )}
            </ul>
            <p className="mt-1 text-amber-800">
              Open a total to see what is in it and give each one a real category. New lines in{' '}
              <Link href="/banking/inbox" className="underline">
                Bank transactions
              </Link>{' '}
              can be categorized as you review them.
            </p>
          </div>
        </div>
      )}

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
          {empty ? (
            <CardBody>
              <EmptyState title="No activity in this period" description="Nothing was recorded between these dates on this basis." />
            </CardBody>
          ) : (
            <Table aria-label="Category report" stickyHeader>
              <THead>
                <TR>
                  <TH className="w-24">Code</TH>
                  <TH>Category</TH>
                  <TH numeric className="w-32">
                    Transactions
                  </TH>
                  <TH numeric>Amount</TH>
                  <CompareHeads on={comparing} priorTitle={priorTitle} />
                </TR>
              </THead>
              <TBody>
                <GroupRows title="Income" group={income} prior={priorIncome} totalLabel="Total income" testId="cat-income" {...groupProps} />
                <GroupRows title="Expenses" group={expense} prior={priorExpense} totalLabel="Total expenses" testId="cat-expense" {...groupProps} />
                <TotalRow label="Profit" labelSpan={3} amount={q.data.netIncome} prior={priorData?.netIncome} compare={comparing} currency={cur} testId="cat-net-income" className="bg-stone-50" />
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}

function GroupRows({
  title,
  group,
  prior,
  totalLabel,
  testId,
  currency,
  from,
  to,
  priorFrom,
  priorTo,
  compare,
  cols,
}: {
  title: string;
  group: Group | undefined;
  prior: Group | undefined;
  totalLabel: string;
  testId: string;
  currency: string;
  from: string;
  to: string;
  priorFrom?: string;
  priorTo?: string;
  compare: boolean;
  cols: number;
}) {
  const lines = mergeLines<CategoryLine>(group?.lines ?? [], compare ? (prior?.lines ?? []) : undefined);
  const count = (group?.lines ?? []).reduce((n, l) => n + l.count, 0);
  return (
    <>
      <SectionHeader title={title} colSpan={cols} />
      {lines.length === 0 && <NoneRow colSpan={cols} />}
      {lines.map((l) => (
        <AccountLineRow
          key={l.accountId}
          line={l}
          currency={currency}
          from={from}
          to={to}
          priorFrom={priorFrom}
          priorTo={priorTo}
          compare={compare}
          testId={testId}
          extra={
            <TD numeric className="text-stone-600">
              {l.line ? l.line.count : 0}
            </TD>
          }
        />
      ))}
      <TotalRow
        label={totalLabel}
        labelSpan={2}
        amount={group?.total ?? '0.00'}
        prior={prior?.total}
        compare={compare}
        currency={currency}
        testId={`${testId}-total`}
        highlightNegative={false}
        extra={
          <TD numeric className="text-stone-600">
            {count}
          </TD>
        }
      />
    </>
  );
}
