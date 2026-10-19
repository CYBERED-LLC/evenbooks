'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DocumentStatus, InvoiceSort } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Input } from '@/components/ui/input';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { ContactPicker } from '@/components/contact-picker';
import { SortableTH, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useInvoices, usePrefetchInvoice } from '@/lib/queries/invoices';
import { useContact } from '@/lib/queries/contacts';
import { formatDate, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { sumDecimals } from '@/lib/decimal';
import { cn } from '@/lib/utils';
import { InvoiceStatusBadge } from '@/components/status-badges';
import { ExportCsvButton } from '@/components/export-csv-button';
import { INVOICE_CSV_COLUMNS, InvoiceBulkBar } from './bulk';

type Tab = 'all' | 'draft' | 'issued' | 'paid' | 'void';
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'issued', label: 'Unpaid' },
  { key: 'paid', label: 'Paid' },
  { key: 'void', label: 'Void' },
];

const FILTER_KEYS = ['q', 'contactId', 'from', 'to', 'overdue'];
const SORTS: readonly InvoiceSort[] = ['issueDate', 'dueDate', 'number', 'customer', 'total', 'balanceDue'];
/** Text columns start A–Z; dates and amounts start newest/largest first (matches the server defaults). */
const defaultDirFor = (sort: InvoiceSort) => (sort === 'number' || sort === 'customer' ? 'asc' : 'desc');

/** Page size: 50, or `?limit=` (1–100) when a link asks for a shorter page. */
export function pageSizeFrom(raw: string | undefined, fallback = 50): number {
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : fallback;
  return Math.min(100, Math.max(1, n));
}

export function InvoicesListView() {
  const { company } = useCompany();
  const router = useRouter();
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const rawTab = list.get('tab');
  const tab = (TABS.some((t) => t.key === rawTab) ? rawTab : 'all') as Tab;
  const pageSize = pageSizeFrom(list.get('limit'));
  const params = {
    status: tab === 'all' ? undefined : (tab as DocumentStatus),
    // "Unpaid" is issued and not yet fully paid: unpaid, partially paid or overdue.
    outstanding: tab === 'issued' ? true : undefined,
    overdue: list.get('overdue') === '1' ? true : undefined,
    contactId: list.get('contactId'),
    from: list.get('from'),
    to: list.get('to'),
    q: list.get('q'),
    sort: SORTS.includes(list.sort as InvoiceSort) ? (list.sort as InvoiceSort) : undefined,
    dir: list.dir,
    cursor: list.cursor,
    limit: pageSize,
  };
  const activeSort = params.sort ?? 'issueDate';
  const activeDir = params.dir ?? defaultDirFor(activeSort);
  const sortProps = {
    sort: activeSort,
    dir: activeDir,
    onSort: list.setSort,
  } as const;

  const q = useInvoices(params);
  const contact = useContact(params.contactId ?? '');
  const prefetch = usePrefetchInvoice();
  const cur = company.baseCurrency;

  useHotkeys({
    n: () => router.push('/invoices/new'),
    '/': () => searchRef.current?.focus(),
  });

  const filters: ActiveFilter[] = [];
  if (params.q) filters.push({ key: 'q', label: `Search: ${params.q}` });
  if (params.contactId) filters.push({ key: 'contactId', label: `Customer: ${contact.data?.name ?? '…'}` });
  if (params.from) filters.push({ key: 'from', label: `From ${formatDate(params.from)}` });
  if (params.to) filters.push({ key: 'to', label: `To ${formatDate(params.to)}` });
  if (params.overdue) filters.push({ key: 'overdue', label: 'Overdue only' });
  const filtered = filters.length > 0;
  const clearAll = () => list.clear(FILTER_KEYS);

  const items = q.data?.items ?? [];

  // Selection is per page: a new filter, sort or page starts with nothing selected.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const listKey = JSON.stringify(params);
  React.useEffect(() => setSelected(new Set()), [listKey]);
  const selectedRows = items.filter((i) => selected.has(i.id));
  const allSelected = items.length > 0 && selectedRows.length === items.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pageBalance = sumDecimals(items.filter((i) => i.status !== 'void').map((i) => i.balanceDue));

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Create an invoice, send it, and record the payment when it arrives. Sent invoices can't be edited; void or credit them instead."
        actions={
          <>
            <LinkButton href="/credit-notes" variant="secondary">
              Credit notes
            </LinkButton>
            <ExportCsvButton
              path="/api/invoices"
              query={{ ...params, cursor: undefined, limit: undefined }}
              filename="invoices.csv"
              columns={INVOICE_CSV_COLUMNS}
            />
            <LinkButton href="/invoices/new" title="New invoice (N)">
              New invoice
            </LinkButton>
          </>
        }
      />
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
          </button>
        ))}
      </nav>
      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search invoices"
            placeholder="Search number, customer, memo… (/)"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
          />
          <ContactPicker bare clearable kind="customer" aria-label="Customer" placeholder="All customers" allowCreate={false} value={params.contactId ?? null} onChange={(id) => list.set('contactId', id)} />
          <Input type="date" aria-label="From date" value={params.from ?? ''} onChange={(e) => list.set('from', e.target.value || null)} />
          <Input type="date" aria-label="To date" value={params.to ?? ''} onChange={(e) => list.set('to', e.target.value || null)} />
          <div className="flex items-center">
            <Checkbox label="Overdue only" checked={params.overdue === true} onChange={(e) => list.set('overdue', e.target.checked ? '1' : null)} />
          </div>
        </div>
      </Card>
      <FilterChips filters={filters} onRemove={(key) => list.clear([key])} onClear={clearAll} />
      {/* Outside the table card so the result dialog survives the list emptying (e.g. issuing every draft on the Draft tab). */}
      <InvoiceBulkBar
        selected={selectedRows}
        onClear={() => setSelected(new Set())}
        onSettled={(ids) => setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))))}
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && (
        <EmptyState
          title="No invoices match"
          description={filtered ? 'Try a wider date range or remove a filter.' : 'Create an invoice to bill a customer; it stays a draft until you issue it.'}
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearAll}>
                Clear filters
              </Button>
            ) : (
              <LinkButton href="/invoices/new">New invoice</LinkButton>
            )
          }
        />
      )}
      {q.data && items.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
          <Table aria-label="Invoices" stickyHeader>
            <THead>
              <TR>
                <TH className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    className="size-4 rounded border-stone-300"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedRows.length > 0 && !allSelected;
                    }}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
                  />
                </TH>
                <SortableTH className="w-28" sortKey="number" defaultDir="asc" {...sortProps}>
                  Number
                </SortableTH>
                <SortableTH sortKey="customer" defaultDir="asc" {...sortProps}>
                  Customer
                </SortableTH>
                <SortableTH className="hidden md:table-cell" sortKey="issueDate" {...sortProps}>
                  Issue date
                </SortableTH>
                <SortableTH className="hidden sm:table-cell" sortKey="dueDate" {...sortProps}>
                  Due date
                </SortableTH>
                <SortableTH numeric className="hidden md:table-cell" sortKey="total" {...sortProps}>
                  Total
                </SortableTH>
                <SortableTH numeric sortKey="balanceDue" {...sortProps}>
                  Balance due
                </SortableTH>
                <TH className="w-32">Status</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((inv) => (
                <TR
                  key={inv.id}
                  href={`/invoices/${inv.id}`}
                  onMouseEnter={() => prefetch(inv.id)}
                  onFocus={() => prefetch(inv.id)}
                  className={selected.has(inv.id) ? 'bg-brand-50/60' : undefined}
                >
                  <TD data-row-click="ignore" className="w-10">
                    <input
                      type="checkbox"
                      aria-label={`Select ${inv.number ?? 'draft'} ${inv.contactName ?? inv.customerSnapshot.name}`}
                      className="size-4 rounded border-stone-300"
                      checked={selected.has(inv.id)}
                      onChange={() => toggle(inv.id)}
                    />
                  </TD>
                  <TD>
                    <Link href={`/invoices/${inv.id}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">
                      {inv.number ?? 'Draft'}
                    </Link>
                  </TD>
                  <TD>
                    <span className="font-medium text-stone-900">{inv.contactName ?? inv.customerSnapshot.name}</span>
                    <p className="text-xs text-stone-500 md:hidden">{formatDate(inv.issueDate)}</p>
                  </TD>
                  <TD className="hidden md:table-cell">{formatDate(inv.issueDate)}</TD>
                  <TD className={cn('hidden sm:table-cell', inv.isOverdue && 'font-medium text-red-700')}>{formatDate(inv.dueDate)}</TD>
                  <TD numeric className="hidden md:table-cell">
                    {formatMoney(inv.total, cur)}
                  </TD>
                  <TD numeric>
                    {inv.status === 'void' ? '—' : formatMoney(inv.balanceDue, cur)}
                  </TD>
                  <TD>
                    <InvoiceStatusBadge invoice={inv} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pager
            count={items.length}
            pageIndex={list.pageIndex}
            pageSize={pageSize}
            hasPrev={list.hasPrev}
            hasNext={!!q.data.nextCursor}
            onPrev={list.prev}
            onNext={() => q.data?.nextCursor && list.next(q.data.nextCursor)}
            noun="invoices"
            total={q.data.total}
            summary={<span data-testid="page-balance-due">{formatMoney(pageBalance, cur)} due on this page</span>}
          />
        </Card>
      )}
    </>
  );
}
