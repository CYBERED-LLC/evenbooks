'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Field } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { reportCsvUrl, reportPdfUrl, useTrialBalance } from '@/lib/queries/reports';
import { capitalize, formatDate, formatMoney } from '@/lib/format';
import { useCompany, useToday } from '@/components/company-context';
import { cn } from '@/lib/utils';
import { PRINT_REPORT, ReportActions, ReportFilters, ReportNote, ReportSkeleton, UpdatingIndicator, asOfPresets, dateParam, glHref, useUrlState } from '../report-controls';

export function TrialBalanceView() {
  const { company } = useCompany();
  const { sp, set } = useUrlState('/reports/trial-balance');
  const today = useToday();
  const presets = React.useMemo(() => asOfPresets(), []);
  const asOf = dateParam(sp, 'asOf', dateParam(sp, 'to', today));

  const q = useTrialBalance({ asOf });
  const cur = q.data?.currency ?? company.baseCurrency;
  const balanced = q.data ? q.data.totalDebit === q.data.totalCredit : null;

  return (
    <>
      <PageHeader
        title="Trial balance"
        description={<ReportNote note={q.data?.note} fallback="For your accountant: every account’s balance on one date, in debit and credit columns." />}
        actions={<ReportActions csvHref={reportCsvUrl('/api/reports/trial-balance', { asOf })} pdfHref={reportPdfUrl('/api/reports/trial-balance', { asOf })} />}
      />

      <ReportFilters>
        <Field label="As of" htmlFor="asOf">
          <DateInput id="asOf" value={asOf} presets={presets} onChange={(v) => v && set({ asOf: v, from: null, to: null })} />
        </Field>
        <UpdatingIndicator show={q.isFetching && !!q.data} />
      </ReportFilters>

      {q.isPending && <ReportSkeleton />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <Card className={cn(PRINT_REPORT, q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || q.isFetching}>
          <CardBody className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-200">
            <p className="text-sm text-stone-600">
              <span className="font-medium text-stone-900">{company.name}</span> · As of {formatDate(q.data.asOf)} · Accrual basis
            </p>
            {balanced ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700" data-testid="tb-balanced">
                <CheckCircle2 className="size-4" aria-hidden /> Debits equal credits
              </span>
            ) : (
              <span role="alert" className="inline-flex items-center gap-1.5 text-sm font-medium text-red-700" data-testid="tb-unbalanced">
                <AlertTriangle className="size-4" aria-hidden /> Debits do not equal credits
              </span>
            )}
          </CardBody>
          {q.data.rows.length === 0 ? (
            <CardBody>
              <EmptyState title="No accounts with activity or balances" description="Balances appear once something is recorded on or before this date." />
            </CardBody>
          ) : (
            <Table aria-label="Trial balance" stickyHeader>
              <THead>
                <TR>
                  <TH className="w-24">Code</TH>
                  <TH>Account</TH>
                  <TH className="hidden md:table-cell">Type</TH>
                  <TH numeric>Debit</TH>
                  <TH numeric>Credit</TH>
                </TR>
              </THead>
              <TBody>
                {q.data.rows.map((r) => (
                  <TR key={r.accountId} href={glHref(r.accountId, r.firstEntryDate, q.data!.asOf)} data-testid="tb-row">
                    <TD className="font-mono text-xs text-stone-500">{r.code}</TD>
                    <TD>
                      <Link href={glHref(r.accountId, r.firstEntryDate, q.data!.asOf)} className="text-brand-700 hover:underline print:text-stone-900 print:no-underline">
                        {r.name}
                      </Link>
                      <p className="text-xs text-stone-500 md:hidden">{capitalize(r.type)}</p>
                    </TD>
                    <TD className="hidden text-stone-600 md:table-cell">{capitalize(r.type)}</TD>
                    <TD numeric>{formatMoney(r.debit, cur)}</TD>
                    <TD numeric>{formatMoney(r.credit, cur)}</TD>
                  </TR>
                ))}
                <TR className="bg-stone-50 font-semibold hover:bg-stone-50">
                  <TD colSpan={2}>Total</TD>
                  <TD className="hidden md:table-cell" />
                  <TD numeric data-testid="tb-total-debit">
                    {formatMoney(q.data.totalDebit, cur)}
                  </TD>
                  <TD numeric data-testid="tb-total-credit">
                    {formatMoney(q.data.totalCredit, cur)}
                  </TD>
                </TR>
              </TBody>
            </Table>
          )}
        </Card>
      )}
    </>
  );
}
