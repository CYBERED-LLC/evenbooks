'use client';
import * as React from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { BarChart3, BookOpen, FileText, Landmark, ListOrdered, Receipt, Scale, Tags } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { taxYears } from '@/lib/tax-years';
import { scheduleCApplies } from '@/lib/queries/reports';
import { useCompany } from '@/components/company-context';
import { DATE_RE, type StoredReportState, useStoredReportState } from './report-controls';

type Carry = 'range' | 'range-basis' | 'as-of' | 'tax-year' | 'none';

interface ReportCard {
  href: string;
  title: string;
  description: string;
  icon: typeof BarChart3;
  carry: Carry;
}

// Owner questions first, accountant tools last.
const reports: ReportCard[] = [
  { href: '/reports/profit-and-loss', title: 'Profit & Loss', description: 'Am I making money? Income minus expenses for a period.', icon: BarChart3, carry: 'range-basis' },
  { href: '/reports/balance-sheet', title: 'Balance sheet', description: 'What the business has, what it owes, and what is left for you, on one date.', icon: Scale, carry: 'as-of' },
  { href: '/reports/category', title: 'Category report', description: 'Where your money came from and went, by category.', icon: Tags, carry: 'range-basis' },
  { href: '/reports/outstanding-invoices', title: 'Outstanding invoices', description: 'Who owes you, and how late they are.', icon: FileText, carry: 'none' },
  { href: '/reports/schedule-c', title: 'Schedule C summary', description: 'Your income and expenses on the lines of Schedule C, the IRS form for sole proprietors.', icon: Receipt, carry: 'tax-year' },
  { href: '/reports/trial-balance', title: 'Trial balance', description: 'For your accountant: every account’s balance on one date.', icon: ListOrdered, carry: 'as-of' },
  { href: '/reports/general-ledger', title: 'General ledger', description: 'For your accountant: every change to one account, with a running balance.', icon: BookOpen, carry: 'range' },
  { href: '/reports/transactions', title: 'All activity', description: 'For your accountant: every line recorded in your books, by date.', icon: Landmark, carry: 'range' },
];

/**
 * Schedule C is only the sole proprietor's form. Other business types still
 * reach it, labeled as such and listed last.
 */
function reportsFor(businessType: string | null): ReportCard[] {
  if (scheduleCApplies(businessType)) return reports;
  const sc = reports.find((r) => r.href === '/reports/schedule-c')!;
  return [
    ...reports.filter((r) => r !== sc),
    { ...sc, title: 'Schedule C (sole proprietors only)', description: 'Not your form: partnerships, corporations and nonprofits file a different return. Your accountant can work from the Profit & Loss.' },
  ];
}

const TAX_YEARS = taxYears();

function hrefFor(base: string, carry: Carry, s: StoredReportState | null): string {
  if (!s?.from || !s.to || carry === 'none') return base;
  const sp = new URLSearchParams();
  if (carry === 'range' || carry === 'range-basis') {
    sp.set('from', s.from);
    sp.set('to', s.to);
    if (carry === 'range-basis' && s.basis) sp.set('basis', s.basis);
  } else if (carry === 'as-of') {
    sp.set('asOf', s.to);
  } else if (carry === 'tax-year') {
    const y = Number(s.to.slice(0, 4));
    if (!TAX_YEARS.includes(y)) return base;
    sp.set('taxYear', String(y));
  }
  return `${base}?${sp.toString()}`;
}

/** Report cards; each link opens with the range last used on any report (or the one in this page's URL). */
export function ReportsIndex() {
  const { company } = useCompany();
  const sp = useSearchParams();
  const stored = useStoredReportState();
  const state = React.useMemo<StoredReportState | null>(() => {
    const from = sp.get('from') ?? '';
    const to = sp.get('to') ?? '';
    const basis = sp.get('basis');
    if (DATE_RE.test(from) && DATE_RE.test(to)) return { from, to, basis: basis === 'cash' || basis === 'accrual' ? basis : stored?.basis };
    return stored;
  }, [sp, stored]);
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Available reports">
      {reportsFor(company.businessType).map((r) => {
        const Icon = r.icon;
        return (
          <li key={r.href}>
            <Link href={hrefFor(r.href, r.carry, state)} className="block h-full rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-200">
              <Card className="h-full transition-colors hover:border-brand-300 hover:bg-brand-50/30">
                <div className="flex h-full items-start gap-3 p-4">
                  <span className="rounded-md bg-brand-50 p-2 text-brand-700" aria-hidden>
                    <Icon className="size-5" />
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium text-stone-900">{r.title}</p>
                    <p className="mt-0.5 text-sm text-stone-500">{r.description}</p>
                  </div>
                </div>
              </Card>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
