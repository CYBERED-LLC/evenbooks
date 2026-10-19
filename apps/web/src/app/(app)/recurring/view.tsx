'use client';
import * as React from 'react';
import Link from 'next/link';
import type { Frequency, RecurringTemplateInput, ScheduleDto } from '@evenbooks/contracts';
import { useRouter } from 'next/navigation';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { usePrefetchSchedule, useSchedules } from '@/lib/queries/recurring';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { multiplyDecimals, sumDecimals } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { cn } from '@/lib/utils';

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  semiannually: 'Every 6 months',
  yearly: 'Yearly',
};

const STATUS_TONE: Record<ScheduleDto['status'], 'green' | 'amber' | 'red' | 'neutral'> = {
  active: 'green',
  paused: 'amber',
  cancelled: 'red',
  completed: 'neutral',
};

export function ScheduleStatusBadge({ status }: { status: ScheduleDto['status'] }) {
  return (
    <span data-testid="schedule-status">
      <Badge tone={STATUS_TONE[status]}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>
    </span>
  );
}

/**
 * The list endpoint omits the server-computed template total. Fall back to the
 * pre-tax, pre-discount line subtotal (BigInt decimal helpers, no float math)
 * and flag it so nobody mistakes it for the invoice total.
 */
export function templateSubtotal(template: RecurringTemplateInput): { amount: string; approximate: boolean } {
  const amount = sumDecimals(template.lines.map((l) => multiplyDecimals(l.quantity || '1', l.unitPrice || '0')));
  const approximate = Boolean(template.documentDiscount) || template.lines.some((l) => l.taxRateIds.length > 0 || l.discount);
  return { amount, approximate };
}

type Tab = 'all' | 'active' | 'paused' | 'ended';
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'ended', label: 'Ended' },
];
const inTab = (s: ScheduleDto, tab: Tab) => tab === 'all' || (tab === 'ended' ? s.status === 'completed' || s.status === 'cancelled' : s.status === tab);

export function RecurringListView() {
  const { company } = useCompany();
  const router = useRouter();
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const q = useSchedules();
  const prefetch = usePrefetchSchedule();
  const cur = company.baseCurrency;
  const rawTab = list.get('tab');
  const tab = (TABS.some((t) => t.key === rawTab) ? rawTab : 'all') as Tab;
  const search = (list.get('q') ?? '').toLowerCase();

  useHotkeys({
    n: () => router.push('/recurring/new'),
    '/': () => searchRef.current?.focus(),
  });

  // The schedules endpoint returns every schedule, so tabs and search filter here.
  const all = q.data ?? [];
  const rows = all.filter((s) => inTab(s, tab) && (!search || s.name.toLowerCase().includes(search) || (s.contactName ?? '').toLowerCase().includes(search)));
  const count = (t: Tab) => all.filter((s) => inTab(s, t)).length;
  const filters: ActiveFilter[] = search ? [{ key: 'q', label: `Search: ${list.get('q')}` }] : [];
  const clearAll = () => list.clear(['q', 'tab']);

  return (
    <>
      <PageHeader
        title="Recurring invoices"
        description="Invoices that bill a customer on a schedule. Each one is created early in the morning (your company’s time zone) on each date. A paused schedule creates nothing; when you resume it, you choose what to do about the dates you missed."
        actions={
          <LinkButton href="/recurring/new" title="New schedule (N)">
            New schedule
          </LinkButton>
        }
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && all.length === 0 && (
        <EmptyState
          title="No recurring schedules"
          description="Repeat an invoice you've already sent, or set up the lines from scratch."
          action={<LinkButton href="/recurring/new">New schedule</LinkButton>}
        />
      )}
      {q.data && all.length > 0 && (
        <>
          <nav aria-label="Status" className="mb-3 flex flex-wrap gap-1 border-b border-stone-200">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                aria-current={tab === t.key ? 'page' : undefined}
                onClick={() => list.set('tab', t.key === 'all' ? null : t.key)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-stone-500 hover:text-stone-800',
                )}
              >
                {t.label}
                <span className="ml-1 text-xs font-normal text-stone-400">{count(t.key)}</span>
              </button>
            ))}
          </nav>
          <Card className="mb-4">
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3">
              <Input ref={searchRef} type="search" aria-label="Search schedules" placeholder="Search name or customer… (/)" value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
            </div>
          </Card>
          <FilterChips filters={filters} onRemove={(key) => list.clear([key])} onClear={clearAll} />
          {rows.length === 0 ? (
            <EmptyState
              title="No schedules match"
              description={search ? 'Try another search or status.' : 'No schedules have this status.'}
              action={
                <Button variant="secondary" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <Card>
              <Table aria-label="Recurring schedules" stickyHeader>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH className="hidden md:table-cell">Customer</TH>
                    <TH className="hidden sm:table-cell">Frequency</TH>
                    <TH>Next invoice</TH>
                    <TH className="hidden lg:table-cell">Last created</TH>
                    <TH>Status</TH>
                    <TH numeric>Each invoice</TH>
                  </TR>
                </THead>
                <TBody>
                  {rows.map((s) => {
                    const total = s.templateTotal ? { amount: s.templateTotal, approximate: false } : templateSubtotal(s.template);
                    return (
                      <TR key={s.id} href={`/recurring/${s.id}`} onMouseEnter={() => prefetch(s.id)} onFocus={() => prefetch(s.id)}>
                        <TD>
                          <Link href={`/recurring/${s.id}`} className="font-medium text-brand-700 hover:underline">
                            {s.name}
                          </Link>
                          <p className="text-xs text-stone-500 md:hidden">{s.contactName}</p>
                        </TD>
                        <TD className="hidden md:table-cell">{s.contactName ?? '—'}</TD>
                        <TD className="hidden sm:table-cell">{FREQUENCY_LABEL[s.frequency]}</TD>
                        <TD>
                          {s.nextOccurrenceDate ? (
                            <>
                              {formatDate(s.nextOccurrenceDate)}
                              {s.nextRunAt && <p className="text-xs text-stone-500">Runs {formatDateTime(s.nextRunAt)}</p>}
                            </>
                          ) : (
                            <span className="text-stone-400">—</span>
                          )}
                        </TD>
                        <TD className="hidden lg:table-cell">{s.lastIssuedAt ? formatDateTime(s.lastIssuedAt) : <span className="text-stone-400">Never</span>}</TD>
                        <TD>
                          <ScheduleStatusBadge status={s.status} />
                        </TD>
                        <TD numeric>
                          {formatMoney(total.amount, cur)}
                          {total.approximate && <p className="text-xs font-normal text-stone-500">before tax and discounts</p>}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
              <Pager count={rows.length} pageIndex={0} pageSize={rows.length} hasPrev={false} hasNext={false} onPrev={() => undefined} onNext={() => undefined} noun={rows.length === 1 ? 'schedule' : 'schedules'} />
            </Card>
          )}
        </>
      )}
    </>
  );
}
