'use client';
import * as React from 'react';
import type { ContactDto, ContactSort } from '@evenbooks/contracts';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { SortableTH, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { useContacts, usePrefetchContact } from '@/lib/queries/contacts';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { ContactDialog } from './contact-dialog';
import { ContactBulkBar } from './bulk';
import { formatDate } from '@/lib/format';
import { ExportCsvButton } from '@/components/export-csv-button';

type Kind = 'customer' | 'vendor';
const PAGE_SIZE = 50;
const FILTER_KEYS = ['q', 'kind', 'archived'];
const SORTS: readonly ContactSort[] = ['name', 'createdAt'];

export function ContactsView() {
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const kindParam = list.get('kind');
  const archivedParam = list.get('archived') === '1';
  // The checkbox answers instantly; the URL (the shareable source of truth) follows.
  const [includeArchived, setIncludeArchived] = React.useState(archivedParam);
  React.useEffect(() => setIncludeArchived(archivedParam), [archivedParam]);
  const params = {
    q: list.get('q'),
    kind: kindParam === 'customer' || kindParam === 'vendor' ? (kindParam as Kind) : undefined,
    includeArchived,
    sort: SORTS.includes(list.sort as ContactSort) ? (list.sort as ContactSort) : undefined,
    dir: list.dir,
    cursor: list.cursor,
    limit: PAGE_SIZE,
  };
  const activeSort = params.sort ?? 'name';
  const activeDir = params.dir ?? (activeSort === 'name' ? 'asc' : 'desc');
  const sortProps = {
    sort: activeSort,
    dir: activeDir,
    onSort: list.setSort,
  } as const;

  const q = useContacts(params);
  const prefetch = usePrefetchContact();
  const items = q.data?.items ?? [];

  // Selection is per page: a new filter, sort or page starts with nothing selected.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const listKey = JSON.stringify(params);
  React.useEffect(() => setSelected(new Set()), [listKey]);
  const selectedRows = items.filter((c) => selected.has(c.id));
  const allSelected = items.length > 0 && selectedRows.length === items.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // "New contact" from the command palette arrives as ?new=1.
  const newParam = list.get('new') === '1';
  const [creating, setCreatingState] = React.useState(newParam);
  React.useEffect(() => {
    if (newParam) setCreatingState(true);
  }, [newParam]);
  const setCreating = (open: boolean) => {
    setCreatingState(open);
    if (!open && list.get('new')) list.setMany({ new: null }, false);
  };

  useHotkeys({
    n: () => setCreating(true),
    '/': () => searchRef.current?.focus(),
  });

  const filters: ActiveFilter[] = [];
  if (params.q) filters.push({ key: 'q', label: `Search: ${params.q}` });
  if (params.kind) filters.push({ key: 'kind', label: params.kind === 'customer' ? 'Customers' : 'Vendors' });
  if (includeArchived) filters.push({ key: 'archived', label: 'Including archived' });
  const filtered = !!(params.q || params.kind);

  return (
    <>
      <PageHeader
        title="Customers & vendors"
        description="The people and businesses you invoice and pay. Anyone with invoices or payments can be archived to hide them, but not deleted."
        actions={
          <>
            <Checkbox
              label="Show archived"
              checked={includeArchived}
              onChange={(e) => {
                setIncludeArchived(e.target.checked);
                list.set('archived', e.target.checked ? '1' : null);
              }}
            />
<ExportCsvButton
              path="/api/contacts"
              query={{ ...params, cursor: undefined, limit: undefined }}
              filename="contacts.csv"
              columns={[
                { header: 'Name', value: (r: ContactDto) => r.name },
                { header: 'Customer', value: (r: ContactDto) => (r.isCustomer ? 'yes' : 'no') },
                { header: 'Vendor', value: (r: ContactDto) => (r.isVendor ? 'yes' : 'no') },
                { header: 'Email', value: (r: ContactDto) => r.email },
                { header: 'Phone', value: (r: ContactDto) => r.phone },
                { header: 'Address line 1', value: (r: ContactDto) => r.billingAddress.line1 },
                { header: 'Address line 2', value: (r: ContactDto) => r.billingAddress.line2 },
                { header: 'City', value: (r: ContactDto) => r.billingAddress.city },
                { header: 'State / region', value: (r: ContactDto) => r.billingAddress.region },
                { header: 'Postal code', value: (r: ContactDto) => r.billingAddress.postalCode },
                { header: 'Archived', value: (r: ContactDto) => (r.isArchived ? 'yes' : 'no') },
              ]}
            />
            <Button onClick={() => setCreating(true)} title="New contact (N)">
              New contact
            </Button>
          </>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search contacts"
            placeholder="Search name or email…"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            className="lg:col-span-2"
          />
          <Select aria-label="Kind" value={params.kind ?? ''} onChange={(e) => list.set('kind', e.target.value || null)}>
            <option value="">All contacts</option>
            <option value="customer">Customers</option>
            <option value="vendor">Vendors</option>
          </Select>
        </div>
      </Card>
      <FilterChips
        filters={filters}
        onRemove={(key) => {
          if (key === 'archived') setIncludeArchived(false);
          list.clear([key]);
        }}
        onClear={() => {
          setIncludeArchived(false);
          list.clear(FILTER_KEYS);
        }}
      />
      {/* Outside the table card so Undo keeps working when archiving empties the page. */}
      <ContactBulkBar
        selected={selectedRows}
        onClear={() => setSelected(new Set())}
        onSettled={(ids) => setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))))}
      />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.items.length === 0 && (
        <EmptyState
          title="No contacts match"
          description={filtered ? 'Try a different search or filter.' : 'Add your first customer or vendor.'}
          action={
            filtered ? (
              <Button variant="secondary" onClick={() => list.clear(['q', 'kind'])}>
                Clear filters
              </Button>
            ) : (
              <Button onClick={() => setCreating(true)}>New contact</Button>
            )
          }
        />
      )}
      {q.data && q.data.items.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
          <Table aria-label="Contacts" stickyHeader>
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
                    onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((c) => c.id)))}
                  />
                </TH>
                <SortableTH sortKey="name" defaultDir="asc" {...sortProps}>
                  Name
                </SortableTH>
                <TH className="w-40">Kind</TH>
                <TH className="hidden md:table-cell">Email</TH>
                <TH className="hidden lg:table-cell">Phone</TH>
                <TH className="hidden lg:table-cell">Location</TH>
                <SortableTH className="hidden w-32 md:table-cell" sortKey="createdAt" {...sortProps}>
                  Added
                </SortableTH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((c) => (
                <TR
                  key={c.id}
                  href={`/contacts/${c.id}`}
                  className={selected.has(c.id) ? 'bg-brand-50/60' : undefined}
                  onMouseEnter={() => prefetch(c.id)}
                  onFocus={() => prefetch(c.id)}
                >
                  <TD data-row-click="ignore" className="w-10">
                    <input type="checkbox" aria-label={`Select ${c.name}`} className="size-4 rounded border-stone-300" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  </TD>
                  <TD className={c.isArchived ? 'opacity-60' : undefined}>
                    <Link href={`/contacts/${c.id}`} className="font-medium text-brand-700 hover:underline">
                      {c.name}
                    </Link>
                    {c.isArchived && (
                      <Badge tone="neutral" className="ml-2">
                        Archived
                      </Badge>
                    )}
                    {c.email && <p className="text-xs text-stone-500 md:hidden">{c.email}</p>}
                  </TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {c.isCustomer && <Badge tone="blue">Customer</Badge>}
                      {c.isVendor && <Badge tone="purple">Vendor</Badge>}
                    </span>
                  </TD>
                  <TD className="hidden md:table-cell">{c.email ?? '—'}</TD>
                  <TD className="hidden lg:table-cell">{c.phone ?? '—'}</TD>
                  <TD className="hidden text-stone-500 lg:table-cell">{[c.billingAddress.city, c.billingAddress.region].filter(Boolean).join(', ') || '—'}</TD>
                  <TD className="hidden whitespace-nowrap text-stone-500 md:table-cell">{formatDate(c.createdAt.slice(0, 10))}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pager
            count={q.data.items.length}
            pageIndex={list.pageIndex}
            pageSize={PAGE_SIZE}
            hasPrev={list.hasPrev}
            hasNext={!!q.data.nextCursor}
            onPrev={list.prev}
            onNext={() => q.data?.nextCursor && list.next(q.data.nextCursor)}
            noun="contacts"
            total={q.data.total}
          />
        </Card>
      )}
      <ContactDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
