'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { DocumentStatus, ListCreditNotesQuery } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { ContactPicker } from '@/components/contact-picker';
import { SortableTH, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useCreditNotes, usePrefetchCreditNote } from '@/lib/queries/credit-notes';
import { useContact } from '@/lib/queries/contacts';
import { formatDate, formatMoney } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { pageSizeFrom } from '@/app/(app)/invoices/view';
import { CreditNoteStatusBadge } from '@/components/status-badges';
import { Term } from '@/components/ui/term';

const STATUSES: DocumentStatus[] = ['draft', 'issued', 'paid', 'void'];
const STATUS_LABEL: Record<DocumentStatus, string> = { draft: 'Draft', issued: 'Credit available', paid: 'Fully used', void: 'Void' };
const FILTER_KEYS = ['q', 'contactId', 'from', 'to', 'status'];
type CreditNoteSort = NonNullable<ListCreditNotesQuery['sort']>;
const SORT_KEYS: readonly CreditNoteSort[] = ['issueDate', 'number', 'total', 'customer'];

export function CreditNotesListView() {
  const { company } = useCompany();
  const router = useRouter();
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const status = list.get('status');
  const pageSize = pageSizeFrom(list.get('limit'));
  const params = {
    status: STATUSES.includes(status as DocumentStatus) ? (status as DocumentStatus) : undefined,
    contactId: list.get('contactId'),
    from: list.get('from'),
    to: list.get('to'),
    q: list.get('q'),
    // an unknown ?sort= falls back to the default instead of failing the request
    sort: SORT_KEYS.includes(list.sort as CreditNoteSort) ? (list.sort as CreditNoteSort) : undefined,
    dir: list.dir,
    cursor: list.cursor,
    limit: pageSize,
  };
  const sortProps = { sort: params.sort ?? 'issueDate', dir: params.dir ?? 'desc', onSort: list.setSort } as const;

  const q = useCreditNotes(params);
  const contact = useContact(params.contactId ?? '');
  const prefetch = usePrefetchCreditNote();
  const cur = company.baseCurrency;

  useHotkeys({
    n: () => router.push('/credit-notes/new'),
    '/': () => searchRef.current?.focus(),
  });

  const filters: ActiveFilter[] = [];
  if (params.q) filters.push({ key: 'q', label: `Search: ${params.q}` });
  if (params.contactId) filters.push({ key: 'contactId', label: `Customer: ${contact.data?.name ?? '…'}` });
  if (params.from) filters.push({ key: 'from', label: `From ${formatDate(params.from)}` });
  if (params.to) filters.push({ key: 'to', label: `To ${formatDate(params.to)}` });
  if (params.status) filters.push({ key: 'status', label: STATUS_LABEL[params.status] });
  const filtered = filters.length > 0;
  const clearAll = () => list.clear(FILTER_KEYS);
  const items = q.data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Credit notes"
        description={
          <>
            A <Term id="credit-note" /> lowers what a customer owes. Put it toward one of their invoices, or refund it; anything left stays as credit for them.
          </>
        }
        actions={
          <>
            <LinkButton href="/invoices" variant="secondary">
              Invoices
            </LinkButton>
            <LinkButton href="/credit-notes/new" title="New credit note (N)">
              New credit note
            </LinkButton>
          </>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search credit notes"
            placeholder="Search number, customer, reason… (/)"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
          />
          <ContactPicker bare clearable kind="customer" aria-label="Customer" placeholder="All customers" allowCreate={false} value={params.contactId ?? null} onChange={(id) => list.set('contactId', id)} />
          <Input type="date" aria-label="From date" value={params.from ?? ''} onChange={(e) => list.set('from', e.target.value || null)} />
          <Input type="date" aria-label="To date" value={params.to ?? ''} onChange={(e) => list.set('to', e.target.value || null)} />
          <Select aria-label="Status" value={params.status ?? ''} onChange={(e) => list.set('status', e.target.value || null)}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </Card>
      <FilterChips filters={filters} onRemove={(key) => list.clear([key])} onClear={clearAll} />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && (
        <EmptyState
          title="No credit notes match"
          description={filtered ? 'Try a wider date range or remove a filter.' : 'Raise a credit note to reduce what a customer owes or to record a refund.'}
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearAll}>
                Clear filters
              </Button>
            ) : (
              <LinkButton href="/credit-notes/new">New credit note</LinkButton>
            )
          }
        />
      )}
      {q.data && items.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
          <Table aria-label="Credit notes" stickyHeader>
            <THead>
              <TR>
                <SortableTH className="w-28" sortKey="number" {...sortProps}>
                  Number
                </SortableTH>
                <SortableTH sortKey="customer" defaultDir="asc" {...sortProps}>
                  Customer
                </SortableTH>
                <SortableTH className="hidden md:table-cell" sortKey="issueDate" {...sortProps}>
                  Issue date
                </SortableTH>
                <TH className="hidden lg:table-cell">Invoice</TH>
                <SortableTH numeric className="hidden sm:table-cell" sortKey="total" {...sortProps}>
                  Total
                </SortableTH>
                <TH numeric>Credit left</TH>
                <TH className="w-24">Status</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((cn) => (
                <TR key={cn.id} href={`/credit-notes/${cn.id}`} onMouseEnter={() => prefetch(cn.id)} onFocus={() => prefetch(cn.id)}>
                  <TD>
                    <Link href={`/credit-notes/${cn.id}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">
                      {cn.number ?? 'Draft'}
                    </Link>
                  </TD>
                  <TD>
                    <span className="font-medium text-stone-900">{cn.contactName ?? cn.customerSnapshot.name}</span>
                    {cn.reason && <p className="truncate text-xs text-stone-500">{cn.reason}</p>}
                  </TD>
                  <TD className="hidden md:table-cell">{formatDate(cn.issueDate)}</TD>
                  <TD className="hidden lg:table-cell">
                    {cn.invoiceId ? (
                      <Link href={`/invoices/${cn.invoiceId}`} className="font-mono text-xs text-brand-700 hover:underline">
                        {cn.invoiceNumber ?? 'Invoice'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </TD>
                  <TD numeric className="hidden sm:table-cell">
                    {formatMoney(cn.total, cur)}
                  </TD>
                  <TD numeric>{cn.status === 'void' ? '—' : formatMoney(cn.balance, cur)}</TD>
                  <TD>
                    <CreditNoteStatusBadge creditNote={cn} />
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
            noun="credit notes"
            total={q.data.total}
          />
        </Card>
      )}
    </>
  );
}
