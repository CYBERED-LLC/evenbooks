'use client';
import * as React from 'react';
import Link from 'next/link';
import { TD, TH, TR } from '@/components/ui/table';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { type MergedLine, change, percentChange } from './compare';
import { glHref, negativeClass } from './report-controls';

/**
 * Rows shared by the statement-style reports (P&L, category, balance sheet):
 * Code | Account | …extra | Amount | [Prior | Change | %].
 * Every account line opens its general ledger: the name is a link and the rest
 * of the row is clickable.
 */

/** `intro` is a short plain-words line after the title (e.g. a `<Term>` saying what the section holds). */
export function SectionHeader({ title, intro, colSpan, tone, className }: { title: string; intro?: React.ReactNode; colSpan: number; tone?: 'amber'; className?: string }) {
  return (
    <TR className="hover:bg-transparent">
      <TD colSpan={colSpan} className={cn('text-xs font-semibold uppercase tracking-wide', tone === 'amber' ? 'text-amber-700' : 'text-stone-500', className)}>
        {title}
        {intro && <span className="ml-2 text-xs font-normal normal-case tracking-normal text-stone-500">{intro}</span>}
      </TD>
    </TR>
  );
}

export function NoneRow({ colSpan }: { colSpan: number }) {
  return (
    <TR className="hover:bg-transparent">
      <TD />
      <TD colSpan={colSpan - 1} className="text-stone-400">
        None
      </TD>
    </TR>
  );
}

/** Extra header cells when comparing. */
export function CompareHeads({ on, priorTitle }: { on: boolean; priorTitle?: string }) {
  if (!on) return null;
  return (
    <>
      <TH numeric title={priorTitle}>
        Prior
      </TH>
      <TH numeric>Change</TH>
      <TH numeric className="hidden sm:table-cell">
        %
      </TH>
    </>
  );
}

/** Prior, change and percent-change cells for one row. */
export function CompareCells({ on, current, prior, currency }: { on: boolean; current: string | null; prior: string | null; currency: string }) {
  if (!on) return null;
  const diff = change(current, prior);
  const pct = percentChange(current, prior);
  return (
    <>
      <TD numeric data-testid="cmp-prior" className={cn('text-stone-600', prior === null && 'text-stone-400')}>
        {prior === null ? '—' : formatMoney(prior, currency)}
      </TD>
      <TD numeric data-testid="cmp-change" className={negativeClass(diff)}>
        {formatMoney(diff, currency)}
      </TD>
      <TD numeric data-testid="cmp-pct" className="hidden text-stone-600 sm:table-cell">
        {pct ?? <span className="text-stone-400">—</span>}
      </TD>
    </>
  );
}

export interface AccountLineRowProps {
  line: MergedLine;
  currency: string;
  /** Range the drill-down general ledger opens with. */
  from: string;
  to: string;
  /** Used when the line only exists in the comparison period. */
  priorFrom?: string;
  priorTo?: string;
  compare: boolean;
  testId: string;
  /** Cells between the account name and the amount (e.g. transaction count). */
  extra?: React.ReactNode;
  highlightNegative?: boolean;
}

export function AccountLineRow({ line, currency, from, to, priorFrom, priorTo, compare, testId, extra, highlightNegative }: AccountLineRowProps) {
  const onlyPrior = line.amount === null;
  const href = onlyPrior && priorFrom && priorTo ? glHref(line.accountId, priorFrom, priorTo) : glHref(line.accountId, from, to);
  return (
    <TR href={href} data-testid={`${testId}-row`} data-only={onlyPrior ? 'prior' : compare && line.prior === null ? 'current' : undefined} className={cn(onlyPrior && 'text-stone-500')}>
      <TD className="font-mono text-xs text-stone-500">{line.code}</TD>
      <TD>
        <Link href={href} className="text-brand-700 hover:underline print:text-stone-900 print:no-underline">
          {line.name}
        </Link>
      </TD>
      {extra}
      <TD numeric className={cn(highlightNegative && negativeClass(line.amount ?? undefined), onlyPrior && 'text-stone-400')}>
        {onlyPrior ? '—' : formatMoney(line.amount, currency)}
      </TD>
      <CompareCells on={compare} current={line.amount} prior={line.prior} currency={currency} />
    </TR>
  );
}

export interface TotalRowProps {
  label: React.ReactNode;
  /** Columns the label spans (code + account + any extra columns before the amount). */
  labelSpan: number;
  amount: string;
  prior?: string | null;
  compare: boolean;
  currency: string;
  testId?: string;
  className?: string;
  /** Cells between the label and the amount (e.g. a count). Counts against nothing in `labelSpan`. */
  extra?: React.ReactNode;
  highlightNegative?: boolean;
}

export function TotalRow({ label, labelSpan, amount, prior, compare, currency, testId, className, extra, highlightNegative = true }: TotalRowProps) {
  return (
    <TR className={cn('font-semibold hover:bg-transparent', className)}>
      <TD colSpan={labelSpan}>{label}</TD>
      {extra}
      <TD numeric data-testid={testId} className={cn(highlightNegative && negativeClass(amount))}>
        {formatMoney(amount, currency)}
      </TD>
      <CompareCells on={compare} current={amount} prior={compare ? (prior ?? '0.00') : null} currency={currency} />
    </TR>
  );
}
