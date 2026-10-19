'use client';
import * as React from 'react';
import Link from 'next/link';
import { Inbox } from 'lucide-react';
import { usePendingReview } from '@/lib/queries/reports';
import { formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface PendingReviewBannerProps {
  /** Start of the period; omit for an "as of" view (everything on or before `to`). */
  from?: string;
  to: string;
  /** What the missing lines are missing from, e.g. "these numbers". */
  subject?: string;
  className?: string;
}

/**
 * Warns that bank transactions in the period are still waiting for review, so
 * they are not in the figures on screen yet, and links to them in the bank
 * inbox. Fetches its own count and renders nothing when there are none (or
 * while loading), so any report or dashboard card can drop it in.
 */
export function PendingReviewBanner({ from, to, subject = 'this report', className }: PendingReviewBannerProps) {
  const q = usePendingReview({ from, to });
  const d = q.data;
  if (!d || d.count === 0 || d.to !== to || (d.from ?? undefined) !== from) return null;
  const one = d.count === 1;
  const when = from ? 'from this period' : `dated on or before ${formatDate(to)}`;
  const sp = new URLSearchParams();
  if (from) sp.set('from', from);
  sp.set('to', to);
  const totals = [!isZeroDecimal(d.moneyIn) && `${formatMoney(d.moneyIn, d.currency)} in`, !isZeroDecimal(d.moneyOut) && `${formatMoney(d.moneyOut, d.currency)} out`].filter(Boolean).join(' · ');
  return (
    <div role="status" className={cn('mb-4 flex items-start gap-3 rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900 print:hidden', className)} data-testid="pending-review-banner">
      <Inbox className="mt-0.5 size-5 shrink-0 text-sky-700" aria-hidden />
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-semibold" data-testid="pending-review-count">
            {d.count} bank {one ? 'transaction' : 'transactions'}
          </span>{' '}
          {when} {one ? 'is' : 'are'} waiting for review and {one ? 'isn’t' : 'aren’t'} in {subject} yet.{' '}
          <Link href={`/banking/inbox?${sp.toString()}`} className="font-medium text-sky-800 underline underline-offset-2 hover:text-sky-900">
            Review {one ? 'it' : 'them'}
          </Link>
        </p>
        {totals && <p className="mt-0.5 text-xs text-sky-800">{totals}</p>}
      </div>
    </div>
  );
}
