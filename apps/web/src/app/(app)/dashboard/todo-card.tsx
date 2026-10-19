'use client';
import * as React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, FilePen, Inbox, Landmark, Scale } from 'lucide-react';
import type { InvoiceDto, Page } from '@evenbooks/contracts';
import { Card, CardHeader } from '@/components/ui/card';
import { useCompany, useToday } from '@/components/company-context';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useBankAccounts } from '@/lib/queries/banking';
import { useReconciliations } from '@/lib/queries/reconciliation';
import { useOutstandingInvoices } from '@/lib/queries/reports';
import { formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { sumDecimals } from '@/lib/decimal';
import { cn } from '@/lib/utils';

const RECONCILE_SHOWN = 2;
const RECONCILE_STALE_DAYS = 45;
const DRAFT_SAMPLE = 100;

interface Todo {
  key: string;
  href: string;
  title: string;
  detail?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: 'amber' | 'red' | 'neutral';
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What needs attention, each line linking to the list already filtered to it. With
 * `hideWhenEmpty` (the setup checklist is showing) an empty list renders nothing.
 */
export function TodoCard({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const { company, isAdmin } = useCompany();
  const bank = useBankAccounts();
  const recs = useReconciliations();
  const outstanding = useOutstandingInvoices();
  const drafts = useQuery({
    queryKey: [...qk.invoices.list(company.id, { status: 'draft', limit: DRAFT_SAMPLE }), 'dashboard'],
    queryFn: ({ signal }) => api<Page<InvoiceDto>>('/api/invoices', { companyId: company.id, signal, query: { status: 'draft', limit: DRAFT_SAMPLE } }),
    staleTime: 30_000,
  });
  const today = useToday();

  const todos: Todo[] = [];
  const active = (bank.data ?? []).filter((b) => b.isActive);
  const unreviewed = active.reduce((n, b) => n + (b.unreviewedCount ?? 0), 0);
  if (unreviewed > 0) {
    const only = active.filter((b) => (b.unreviewedCount ?? 0) > 0);
    todos.push({
      key: 'inbox',
      href: only.length === 1 ? `/banking/inbox?bankAccountId=${only[0]!.id}` : '/banking/inbox',
      title: `${plural(unreviewed, 'bank transaction', 'bank transactions')} to review`,
      detail: only.length === 1 ? only[0]!.name : `Across ${only.length} accounts`,
      icon: Inbox,
      tone: 'amber',
    });
  }

  const overdue = (outstanding.data?.items ?? []).filter((i) => i.daysOverdue > 0);
  if (overdue.length > 0) {
    todos.push({
      key: 'overdue',
      href: '/invoices?overdue=1',
      title: `${plural(overdue.length, 'overdue invoice', 'overdue invoices')}`,
      detail: `${formatMoney(sumDecimals(overdue.map((i) => i.balanceDue)), outstanding.data?.currency)} past due`,
      icon: AlertTriangle,
      tone: 'red',
    });
  }

  const draftCount = drafts.data?.items.length ?? 0;
  if (draftCount > 0) {
    todos.push({
      key: 'drafts',
      href: '/invoices?tab=draft',
      title: `${drafts.data?.nextCursor ? `${DRAFT_SAMPLE}+` : draftCount} draft ${draftCount === 1 && !drafts.data?.nextCursor ? 'invoice' : 'invoices'} not yet issued`,
      icon: FilePen,
      tone: 'neutral',
    });
  }

  if (recs.data) {
    for (const b of active) {
      const done = recs.data
        .filter((r) => r.bankAccountId === b.id && r.status === 'completed')
        .map((r) => r.statementEndDate)
        .sort()
        .at(-1);
      if (done) {
        const age = daysBetween(done, today);
        if (age >= RECONCILE_STALE_DAYS)
          todos.push({
            key: `rec:${b.id}`,
            href: `/banking/reconcile?bankAccountId=${b.id}`,
            title: `Check ${b.name} against your statement`,
            detail: `Last checked through ${formatDate(done)} (${age} days ago)`,
            icon: Scale,
            tone: 'neutral',
          });
      } else if (!isZeroDecimal(b.ledgerBalance) || (b.unreviewedCount ?? 0) > 0) {
        todos.push({
          key: `rec:${b.id}`,
          href: `/banking/reconcile?bankAccountId=${b.id}`,
          title: `Check ${b.name} against your statement`,
          detail: 'Not checked yet',
          icon: Scale,
          tone: 'neutral',
        });
      }
    }
  }

  // Many bank accounts would bury the other items: show a couple, then one summary row.
  const recTodos = todos.filter((t) => t.key.startsWith('rec:'));
  if (recTodos.length > RECONCILE_SHOWN + 1) {
    const hidden = recTodos.slice(RECONCILE_SHOWN);
    const firstHidden = todos.indexOf(hidden[0]!);
    todos.splice(firstHidden, hidden.length, {
      key: 'rec:more',
      href: '/banking/reconcile',
      title: `${hidden.length} more accounts to check against their statements`,
      icon: Scale,
      tone: 'neutral',
    });
  }

  const loading = bank.isPending || outstanding.isPending || drafts.isPending || recs.isPending;
  if (hideWhenEmpty && !loading && todos.length === 0) return null;
  // "All caught up" is only true once there is a bank account to keep up with.
  const noBanks = !loading && active.length === 0;

  return (
    <Card className="mb-6" data-testid="dashboard-todo">
      <CardHeader title="To do" description={loading ? 'Checking what needs attention…' : undefined} />
      {!loading && todos.length === 0 ? (
        noBanks ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-sm text-stone-600">
            <Landmark className="size-4 text-stone-500" aria-hidden /> Nothing to review yet. Bank transactions show up here once a bank account is added.
            {isAdmin && (
              <Link href="/banking" className="font-medium text-brand-700 hover:underline">
                Add a bank account
              </Link>
            )}
          </p>
        ) : (
          <p className="flex items-center gap-2 px-4 py-3 text-sm text-stone-600">
            <CheckCircle2 className="size-4 text-brand-600" aria-hidden /> You are all caught up.
          </p>
        )
      ) : (
        <ul className="divide-y divide-stone-100" aria-label="To do">
          {todos.map((t) => (
            <li key={t.key}>
              <Link href={t.href} className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-sm hover:bg-stone-50">
                <t.icon
                  className={cn('size-4 shrink-0', t.tone === 'red' ? 'text-red-600' : t.tone === 'amber' ? 'text-amber-600' : 'text-stone-500')}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-stone-900">{t.title}</span>
                  {t.detail && <span className="ml-2 text-stone-500">{t.detail}</span>}
                </span>
                <ChevronRight className="size-4 shrink-0 text-stone-400" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
