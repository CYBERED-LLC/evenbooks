'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { LinkButton } from '@/components/ui/button';
import { Card, CardBody, EmptyState, ErrorNotice, PageHeader } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/input';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { type ReportBasis, type ScheduleCLine, reportCsvUrl, reportPdfUrl, scheduleCApplies, useScheduleC } from '@/lib/queries/reports';
import { formatMoney, isZeroDecimal } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { cn } from '@/lib/utils';
import { PendingReviewBanner } from '@/components/pending-review-banner';
import {
  BasisToggle,
  CashLedgerNote,
  PRINT_REPORT,
  ReportActions,
  ReportFilters,
  ReportNote,
  ReportSkeleton,
  UpdatingIndicator,
  glHref,
  negativeClass,
  useHydrated,
  useStoredReportState,
  useUrlState,
} from '../report-controls';
import { taxYears } from '@/lib/tax-years';

export const TAX_YEARS = taxYears();

export function ScheduleCView() {
  const { company } = useCompany();
  const { sp, set } = useUrlState('/reports/schedule-c');
  const hydrated = useHydrated();
  const stored = useStoredReportState();
  const currentYear = React.useMemo(() => new Date().getFullYear(), []);
  const yearParam = Number(sp.get('taxYear'));
  // The URL wins; otherwise the year of the period last used on another report.
  const storedYear = stored?.to ? Number(stored.to.slice(0, 4)) : NaN;
  const taxYear = TAX_YEARS.includes(yearParam)
    ? yearParam
    : TAX_YEARS.includes(storedYear)
      ? storedYear
      : TAX_YEARS.includes(currentYear)
        ? currentYear
        : TAX_YEARS[TAX_YEARS.length - 1]!;
  const ready = hydrated || TAX_YEARS.includes(yearParam);
  // Schedule C opens on how the company reports taxes; most sole proprietors file on the cash basis.
  const basisParam = sp.get('basis');
  const basis: ReportBasis = basisParam === 'accrual' || basisParam === 'cash' ? basisParam : (company.taxBasis ?? 'cash');

  const q = useScheduleC({ taxYear, basis }, ready);
  const cur = q.data?.currency ?? company.baseCurrency;
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggle = (code: string) => setExpanded((e) => ({ ...e, [code]: !e[code] }));

  const incomeLines = q.data?.lines.filter((l) => l.part === 'income') ?? [];
  const expenseLines = q.data?.lines.filter((l) => l.part === 'expense') ?? [];
  const otherLines = q.data?.lines.filter((l) => l.part !== 'income' && l.part !== 'expense') ?? [];
  const from = `${taxYear}-01-01`;
  const to = `${taxYear}-12-31`;
  const nothing = q.data && q.data.lines.every((l) => l.accounts.length === 0) && q.data.unmapped.length === 0;

  return (
    <>
      <PageHeader
        title="Schedule C summary"
        description={<ReportNote note={q.data?.note} fallback="Your income and expenses added up on the lines of Schedule C, the IRS form for sole proprietors." />}
        actions={
          <ReportActions csvHref={reportCsvUrl('/api/reports/schedule-c', { taxYear, basis })} pdfHref={reportPdfUrl('/api/reports/schedule-c', { taxYear, basis })}>
            <LinkButton href={`/settings/mappings?year=${taxYear}`} variant="secondary">
              Choose tax lines
            </LinkButton>
          </ReportActions>
        }
      />

      <ReportFilters>
        <Field label="Tax year" htmlFor="taxYear">
          <Select id="taxYear" value={String(taxYear)} onChange={(e) => set({ taxYear: e.target.value })}>
            {TAX_YEARS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </Field>
        <BasisToggle basis={basis} onChange={(b) => set({ taxYear: String(taxYear), basis: b })} />
        <UpdatingIndicator show={q.isFetching && !!q.data} />
      </ReportFilters>

      {!scheduleCApplies(company.businessType) && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-stone-200 bg-stone-50 px-4 py-3 text-sm text-stone-700 print:hidden" data-testid="schedule-c-not-your-form">
          <Info className="mt-0.5 size-4 shrink-0 text-stone-500" aria-hidden />
          Schedule C is for sole proprietors and single-member LLCs. Partnerships, corporations and nonprofits file a different return; your accountant can work from the Profit &amp; Loss instead.
        </p>
      )}

      {ready && <PendingReviewBanner from={from} to={to} />}

      {q.data &&
        q.data.uncategorized.map((u) => (
          <div key={u.accountId} role="status" className="mb-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 print:hidden" data-testid="schedule-c-uncategorized">
            <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1">
              <span className="font-semibold">
                <span className="tabular">{formatMoney(u.amount, cur)}</span> of {u.type === 'income' ? 'income' : 'spending'} hasn’t been sorted into a category yet.
              </span>{' '}
              {u.lineCode ? `It’s included on line ${u.lineCode} (${u.lineLabel}) until you categorize it.` : 'It isn’t on any line until you categorize it.'}{' '}
              <Link href={glHref(u.accountId, from, to)} className="font-medium underline">
                See what’s in it
              </Link>
            </p>
          </div>
        ))}

      {q.data && q.data.unmapped.length > 0 && (
        <div role="status" className="mb-4 flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 print:hidden" data-testid="schedule-c-unmapped">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              {q.data.unmapped.length} {q.data.unmapped.length === 1 ? 'category doesn’t' : 'categories don’t'} have a Schedule C line yet.
            </p>
            <p>
              Their {taxYear} totals are listed at the end but aren’t on any line.{' '}
              <Link href={`/settings/mappings?year=${taxYear}`} className="font-medium underline">
                Choose a line for {q.data.unmapped.length === 1 ? 'it' : 'them'}
              </Link>
              .
            </p>
          </div>
        </div>
      )}

      {(!ready || q.isPending) && <ReportSkeleton />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <Card className={cn(PRINT_REPORT, q.isPlaceholderData && 'opacity-60 transition-opacity')} aria-busy={q.isPlaceholderData || q.isFetching}>
          <CardBody className="border-b border-stone-200">
            <p className="text-sm text-stone-600">
              <span className="font-medium text-stone-900">{company.name}</span> · Tax year {q.data.taxYear} · {q.data.basis === 'cash' ? 'Cash' : 'Accrual'} basis
            </p>
            <CashLedgerNote show={q.data.basis === 'cash'} />
          </CardBody>
          {nothing ? (
            <CardBody>
              <EmptyState
                title={`No income or expense activity in ${taxYear}`}
                description="Once income and expenses are recorded in this tax year, each category adds up on its Schedule C line here."
              />
            </CardBody>
          ) : (
            <Table aria-label="Schedule C summary" stickyHeader>
              <THead>
                <TR>
                  <TH className="w-20">Line</TH>
                  <TH>Description</TH>
                  <TH numeric>Amount</TH>
                </TR>
              </THead>
              <TBody>
                <PartHeader title="Part I — Income" />
                {incomeLines.map((l) => (
                  <LineRows key={l.code} line={l} currency={cur} expanded={!!expanded[l.code]} onToggle={() => toggle(l.code)} from={from} to={to} />
                ))}
                <TR className="font-semibold">
                  <TD />
                  <TD>Gross receipts (line 1 − line 2 + line 6)</TD>
                  <TD numeric data-testid="sc-gross-receipts" className={negativeClass(q.data.grossReceipts)}>
                    {formatMoney(q.data.grossReceipts, cur)}
                  </TD>
                </TR>

                <PartHeader title="Part II — Expenses" />
                {expenseLines.map((l) => (
                  <LineRows key={l.code} line={l} currency={cur} expanded={!!expanded[l.code]} onToggle={() => toggle(l.code)} from={from} to={to} />
                ))}
                <TR className="font-semibold">
                  <TD />
                  <TD>Total expenses</TD>
                  <TD numeric data-testid="sc-total-expenses">
                    {formatMoney(q.data.totalExpenses, cur)}
                  </TD>
                </TR>

                <TR className="bg-stone-50 font-semibold">
                  <TD />
                  <TD>Tentative profit (gross receipts − total expenses)</TD>
                  <TD numeric data-testid="sc-tentative-profit" className={negativeClass(q.data.tentativeProfit)}>
                    {formatMoney(q.data.tentativeProfit, cur)}
                  </TD>
                </TR>

                {otherLines.some((l) => l.accounts.length > 0) && (
                  <>
                    <PartHeader title="Not on Schedule C" />
                    {otherLines
                      .filter((l) => l.accounts.length > 0)
                      .map((l) => (
                        <LineRows key={l.code} line={l} currency={cur} expanded={!!expanded[l.code]} onToggle={() => toggle(l.code)} from={from} to={to} muted />
                      ))}
                  </>
                )}

                {q.data.unmapped.length > 0 && (
                  <>
                    <PartHeader title="Categories without a tax line" tone="amber" />
                    {q.data.unmapped.map((a) => (
                      <TR key={a.accountId} href={glHref(a.accountId, from, to)} className="bg-amber-50/40" data-testid="sc-unmapped-row">
                        <TD className="font-mono text-xs text-stone-500">{a.code}</TD>
                        <TD>
                          <Link href={glHref(a.accountId, from, to)} className="text-brand-700 hover:underline print:text-stone-900 print:no-underline">
                            {a.name}
                          </Link>
                        </TD>
                        <TD numeric>{formatMoney(a.amount, cur)}</TD>
                      </TR>
                    ))}
                  </>
                )}
              </TBody>
            </Table>
          )}
          <CardBody className="border-t border-stone-200">
            <p className="flex items-start gap-2 text-xs text-stone-500" data-testid="schedule-c-caption">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Adds up your categories by the line you chose for each. It doesn’t decide what is deductible and is not tax advice.
            </p>
          </CardBody>
        </Card>
      )}
    </>
  );
}

function PartHeader({ title, tone }: { title: string; tone?: 'amber' }) {
  return (
    <TR>
      <TD colSpan={3} className={cn('pt-4 text-xs font-semibold uppercase tracking-wide', tone === 'amber' ? 'text-amber-700' : 'text-stone-500')}>
        {title}
      </TD>
    </TR>
  );
}

function LineRows({
  line,
  currency,
  expanded,
  onToggle,
  from,
  to,
  muted,
}: {
  line: ScheduleCLine;
  currency: string;
  expanded: boolean;
  onToggle: () => void;
  from: string;
  to: string;
  muted?: boolean;
}) {
  const hasAccounts = line.accounts.length > 0;
  const zero = isZeroDecimal(line.amount) && !hasAccounts;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <TR data-testid="sc-line" className={cn(zero && 'text-stone-400', muted && 'text-stone-600')}>
        <TD className="font-mono text-xs">{line.code === 'excluded' ? '—' : line.code}</TD>
        <TD>
          {hasAccounts ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} accounts for line ${line.code}`}
              className="inline-flex items-center gap-1 text-left text-stone-900 hover:text-brand-700"
            >
              <Chevron className="size-4 shrink-0 text-stone-400" aria-hidden />
              <span>{line.label}</span>
              <span className="ml-1 text-xs text-stone-500">
                ({line.accounts.length} {line.accounts.length === 1 ? 'category' : 'categories'})
              </span>
            </button>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block size-4" aria-hidden />
              {line.label}
            </span>
          )}
          {line.note && (
            <p className="mt-0.5 flex items-start gap-1 pl-5 text-xs text-stone-500" data-testid="sc-line-note">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              {line.note}
            </p>
          )}
        </TD>
        <TD numeric className={negativeClass(line.amount)}>
          {formatMoney(line.amount, currency)}
        </TD>
      </TR>
      {expanded &&
        line.accounts.map((a) => (
          <TR key={a.accountId} href={glHref(a.accountId, from, to)} className="bg-stone-50/60 text-stone-700" data-testid="sc-account-row">
            <TD className="pl-6 font-mono text-xs text-stone-500">{a.code}</TD>
            <TD className="pl-8">
              <Link href={glHref(a.accountId, from, to)} className="text-brand-700 hover:underline print:text-stone-900 print:no-underline">
                {a.name}
              </Link>
            </TD>
            <TD numeric>{formatMoney(a.amount, currency)}</TD>
          </TR>
        ))}
    </>
  );
}
