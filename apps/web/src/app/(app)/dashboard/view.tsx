'use client';
import * as React from 'react';
import Link from 'next/link';
import type { AccountDto } from '@evenbooks/contracts';
import { Badge, Card, CardBody, CardHeader, PageHeader, Spinner, ErrorNotice } from '@/components/ui/card';
import { Term } from '@/components/ui/term';
import { useAccounts } from '@/lib/queries/accounts';
import { useOutstandingInvoices, useProfitAndLoss } from '@/lib/queries/reports';
import { useCompany, useToday } from '@/components/company-context';
import { formatDate, formatMoney } from '@/lib/format';
import { LinkButton } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { subtractDecimals, sumDecimals } from '@/lib/decimal';
import { ImportPrompt } from '@/components/import-prompt';
import { useBankAccounts } from '@/lib/queries/banking';
import { PendingReviewBanner } from '@/components/pending-review-banner';
import { TodoCard } from './todo-card';
import { SetupChecklist, useSetupChecklistVisible } from './setup-checklist';

function sum(values: (string | undefined)[]): string {
  return sumDecimals(values.filter((v): v is string => !!v));
}

/** First and last day of the month `today` (YYYY-MM-DD, company time) falls in. */
function monthOf(today: string): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${String(last).padStart(2, '0')}` };
}

export function DashboardView() {
  const { company } = useCompany();
  const q = useAccounts({ withBalances: true });
  const today = useToday();
  const month = React.useMemo(() => monthOf(today), [today]);
  const outstanding = useOutstandingInvoices();
  const accrual = useProfitAndLoss({ ...month, basis: 'accrual' });
  const cashPnl = useProfitAndLoss({ ...month, basis: 'cash' });
  const bankAccounts = useBankAccounts();
  const setup = useSetupChecklistVisible();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const accounts = q.data;
  const cash = accounts.filter((a) => a.role === 'bank' || a.role === 'undeposited_funds');
  const cards = accounts.filter((a) => a.role === 'credit_card');
  const ar = accounts.find((a) => a.role === 'accounts_receivable');
  const income = sum(accounts.filter((a) => a.type === 'income').map((a) => a.balance));
  const expense = sum(accounts.filter((a) => a.type === 'expense').map((a) => a.balance));
  const cur = company.baseCurrency;
  const bankByLedger = new Map((bankAccounts.data ?? []).map((b) => [b.ledgerAccountId, b] as const));
  const pnlHref = (basis: 'cash' | 'accrual') => `/reports/profit-and-loss?from=${month.from}&to=${month.to}&basis=${basis}`;
  const basisCards = [
    <BasisCard key="accrual" label="Invoiced (accrual)" report={accrual.data} pending={accrual.isPending} currency={cur} href={pnlHref('accrual')} />,
    <BasisCard key="cash" label="Money received (cash)" report={cashPnl.data} pending={cashPnl.isPending} currency={cur} href={pnlHref('cash')} />,
  ];
  // Lead with the way the owner reports taxes.
  if (company.taxBasis === 'cash') basisCards.reverse();

  return (
    <>
      <PageHeader
        title={company.name}
        description="Updated as you record invoices, payments and bank activity."
        actions={
          <>
            <LinkButton variant="secondary" size="sm" href="/purchases/new">
              Record expense
            </LinkButton>
            <LinkButton size="sm" href="/invoices/new">
              New invoice
            </LinkButton>
          </>
        }
      />
      <ImportPrompt />
      {setup.visible && setup.steps && <SetupChecklist steps={setup.steps} />}
      <TodoCard hideWhenEmpty={setup.visible} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Cash" value={formatMoney(sum(cash.map((a) => a.balance)), cur)} href="/banking" />
        <Stat label={<Term id="receivable">Customers owe you</Term>} linkLabel="Customers owe you" value={formatMoney(ar?.balance ?? '0', cur)} href="/reports/outstanding-invoices" />
        <Stat label="Owed on credit cards" value={formatMoney(sum(cards.map((a) => a.balance)), cur)} href="/banking" />
        <Stat
          label={
            <>
              <Term id="profit">Profit</Term>, all time
            </>
          }
          linkLabel="Profit, all time"
          value={formatMoney(subtractDecimals(income, expense), cur)}
          href="/reports/profit-and-loss"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card data-testid="dashboard-outstanding">
          <CardHeader
            title="Unpaid invoices"
            description={outstanding.data ? `As of ${formatDate(outstanding.data.asOf)}` : undefined}
            actions={
              <LinkButton variant="secondary" size="sm" href="/reports/outstanding-invoices">
                View report
              </LinkButton>
            }
          />
          <CardBody>
            {outstanding.isPending && <Spinner />}
            {outstanding.isError && <ErrorNotice error={outstanding.error} onRetry={() => outstanding.refetch()} />}
            {outstanding.data && (
              <div className="grid gap-3 sm:grid-cols-3">
                <MiniStat label="Total due" value={formatMoney(outstanding.data.total, outstanding.data.currency)} hint={`${outstanding.data.items.length} unpaid`} />
                <MiniStat
                  label="Overdue"
                  value={String(outstanding.data.items.filter((i) => i.daysOverdue > 0).length)}
                  hint={outstanding.data.items.some((i) => i.daysOverdue > 0) ? 'invoices past due' : 'nothing past due'}
                  tone={outstanding.data.items.some((i) => i.daysOverdue > 0) ? 'red' : undefined}
                />
                <MiniStat
                  label="90+ days late"
                  value={formatMoney(outstanding.data.aging.d90plus, outstanding.data.currency)}
                  tone={outstanding.data.aging.d90plus !== '0.00' ? 'red' : undefined}
                />
              </div>
            )}
          </CardBody>
        </Card>

        <Card data-testid="dashboard-cash-vs-accrual">
          <CardHeader
            title="This month"
            description={`Profit, ${formatDate(month.from)} – ${formatDate(month.to)}`}
            actions={
              <LinkButton variant="secondary" size="sm" href={pnlHref(company.taxBasis ?? 'accrual')}>
                Profit & Loss
              </LinkButton>
            }
          />
          <CardBody>
            <PendingReviewBanner from={month.from} to={month.to} subject="these numbers" className="mb-3" />
            {(accrual.isError || cashPnl.isError) && <ErrorNotice error={accrual.error ?? cashPnl.error} onRetry={() => (accrual.isError ? accrual.refetch() : cashPnl.refetch())} />}
            <div className="grid gap-3 sm:grid-cols-2">{basisCards}</div>
            <p className="mt-3 text-xs text-stone-500">Accrual counts invoices when you send them; cash counts them when you’re paid.</p>
          </CardBody>
        </Card>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <AccountList
          title="Bank accounts"
          accounts={cash}
          empty={
            <>
              No bank accounts yet.{' '}
              <Link href="/banking" className="text-brand-700 hover:underline">
                Add a bank account
              </Link>
            </>
          }
          bankByLedger={bankByLedger}
          currency={cur}
        />
        {cards.length > 0 && <AccountList title="Credit cards (owed)" accounts={cards} bankByLedger={bankByLedger} currency={cur} />}
      </div>
    </>
  );
}

function AccountList({
  title,
  accounts,
  empty,
  bankByLedger,
  currency,
}: {
  title: string;
  accounts: AccountDto[];
  empty?: React.ReactNode;
  bankByLedger: Map<string, { id: string; unreviewedCount?: number }>;
  currency: string;
}) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="divide-y divide-stone-100 p-0">
        {accounts.length === 0 && <p className="px-4 py-3 text-sm text-stone-500">{empty}</p>}
        {accounts.map((a) => {
          const bank = bankByLedger.get(a.id);
          const toReview = bank?.unreviewedCount ?? 0;
          return (
            <Link
              key={a.id}
              href={bank ? `/banking/inbox?bankAccountId=${bank.id}` : `/reports/general-ledger?accountId=${a.id}`}
              className="flex min-h-10 items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-stone-50"
            >
              <span className="min-w-0 truncate">{a.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                {toReview > 0 && <Badge tone="amber">{toReview} to review</Badge>}
                <span className="tabular">{formatMoney(a.balance ?? '0', currency)}</span>
              </span>
            </Link>
          );
        })}
      </CardBody>
    </Card>
  );
}

function MiniStat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'red' }) {
  return (
    <div className="rounded-md border border-stone-200 px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className={cn('tabular mt-0.5 text-lg font-semibold', tone === 'red' ? 'text-red-700' : 'text-stone-900')}>{value}</p>
      {hint && <p className="text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

function BasisCard({ label, report, pending, currency, href }: { label: string; report: { netIncome: string; totalIncome: string; totalExpenses: string } | undefined; pending: boolean; currency: string; href: string }) {
  return (
    <Link href={href} className="block rounded-md border border-stone-200 px-3 py-2 transition-colors hover:border-brand-300 hover:bg-brand-50/30">
      <p className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-stone-500">
        {label}
        {pending && <Badge tone="neutral">Loading</Badge>}
      </p>
      <p className={cn('tabular mt-0.5 text-lg font-semibold', report?.netIncome.startsWith('-') ? 'text-red-700' : 'text-stone-900')}>{report ? formatMoney(report.netIncome, currency) : '—'}</p>
      {report && (
        <p className="text-xs text-stone-500">
          {formatMoney(report.totalIncome, currency)} income · {formatMoney(report.totalExpenses, currency)} expenses
        </p>
      )}
    </Link>
  );
}

/**
 * A headline number linking to its report. The label may hold a `Term` (a button), so the
 * link is stretched over the card instead of wrapping it; `linkLabel` names the link.
 */
function Stat({ label, linkLabel, value, href }: { label: React.ReactNode; linkLabel?: string; value: string; href: string }) {
  return (
    <Card className="relative h-full transition-colors focus-within:ring-2 focus-within:ring-brand-500 hover:border-brand-300">
      <CardBody>
        <p className="relative z-10 w-fit text-sm font-medium text-stone-600">{label}</p>
        <Link
          href={href}
          aria-label={`${linkLabel ?? (typeof label === 'string' ? label : '')}: ${value}`}
          className="tabular mt-1 block text-2xl font-semibold text-stone-900 after:absolute after:inset-0 after:rounded-lg focus:outline-none"
        >
          {value}
        </Link>
      </CardBody>
    </Card>
  );
}
