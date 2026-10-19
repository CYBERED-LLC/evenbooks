'use client';
import * as React from 'react';
import type { ListPurchasesQuery, PurchaseDto } from '@evenbooks/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { SortableTH, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { AccountPicker, accountLabel } from '@/components/account-picker';
import { ContactPicker } from '@/components/contact-picker';
import { usePrefetchPurchase, usePurchases } from '@/lib/queries/purchases';
import { useAccounts } from '@/lib/queries/accounts';
import { useContact } from '@/lib/queries/contacts';
import { formatDate, formatMoney } from '@/lib/format';
import { negateDecimal, sumDecimals } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { isPaymentAccount } from './purchase-form';
import { ExportCsvButton } from '@/components/export-csv-button';

const PAGE_SIZE = 50;
const FILTER_KEYS = ['q', 'from', 'to', 'status', 'contactId', 'accountId'];
type PurchaseSort = NonNullable<ListPurchasesQuery['sort']>;
const SORT_KEYS: readonly PurchaseSort[] = ['date', 'total', 'vendor', 'reference'];

export function PurchasesListView() {
  const { company } = useCompany();
  const router = useRouter();
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const params = {
    from: list.get('from'),
    to: list.get('to'),
    status: list.get('status') as 'posted' | 'void' | undefined,
    contactId: list.get('contactId'),
    accountId: list.get('accountId'),
    q: list.get('q'),
    // an unknown ?sort= falls back to the default instead of failing the request
    sort: SORT_KEYS.includes(list.sort as PurchaseSort) ? (list.sort as PurchaseSort) : undefined,
    dir: list.dir,
    cursor: list.cursor,
    limit: PAGE_SIZE,
  };
  const sortProps = { sort: params.sort ?? 'date', dir: params.dir ?? 'desc', onSort: list.setSort } as const;

  const q = usePurchases(params);
  const prefetch = usePrefetchPurchase();
  const accounts = useAccounts();
  const vendor = useContact(params.contactId ?? '');
  const cur = company.baseCurrency;

  useHotkeys({
    n: () => router.push('/purchases/new'),
    '/': () => searchRef.current?.focus(),
  });

  const paidFrom = params.accountId ? (accounts.data ?? []).find((a) => a.id === params.accountId) : undefined;
  const filters: ActiveFilter[] = [];
  if (params.q) filters.push({ key: 'q', label: `Search: ${params.q}` });
  if (params.contactId) filters.push({ key: 'contactId', label: `Vendor: ${vendor.data?.name ?? '…'}` });
  if (params.accountId) filters.push({ key: 'accountId', label: `${!paidFrom || isPaymentAccount(paidFrom) ? 'Paid from' : 'Category'}: ${paidFrom ? accountLabel(paidFrom) : '…'}` });
  if (params.from) filters.push({ key: 'from', label: `From ${formatDate(params.from)}` });
  if (params.to) filters.push({ key: 'to', label: `To ${formatDate(params.to)}` });
  if (params.status) filters.push({ key: 'status', label: params.status === 'posted' ? 'Not voided' : 'Void' });
  const filtered = filters.length > 0;
  const clearAll = () => list.clear(FILTER_KEYS);

  // Net money out on this page: expenses paid minus vendor refunds, voids excluded.
  const pageNet = sumDecimals((q.data?.items ?? []).filter((p) => p.status === 'posted').map((p) => (p.direction === 'outflow' ? p.total : negateDecimal(p.total))));

  return (
    <>
      <PageHeader
        title="Expenses"
        description="What you paid for from a bank account or card. To fix a mistake, void it and enter it again."
        actions={
          <>
            <ExportCsvButton
              path="/api/purchases"
              query={{ ...params, cursor: undefined, limit: undefined }}
              filename="purchases.csv"
              columns={[
                { header: 'Date', value: (r: PurchaseDto) => r.date },
                { header: 'Vendor', value: (r: PurchaseDto) => r.contactName },
                { header: 'Paid from', value: (r: PurchaseDto) => r.paidFromAccountName },
                { header: 'Reference', value: (r: PurchaseDto) => r.reference },
                { header: 'Note', value: (r: PurchaseDto) => r.memo },
                { header: 'Type', value: (r: PurchaseDto) => (r.direction === 'outflow' ? 'Paid' : 'Vendor refund') },
                { header: 'Status', value: (r: PurchaseDto) => (r.status === 'void' ? 'Void' : 'Recorded') },
                { header: 'Total', value: (r: PurchaseDto) => r.total },
              ]}
            />
            <LinkButton href="/purchases/new">Record expense</LinkButton>
          </>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6">
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search expenses"
            placeholder="Search note or reference…"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
          />
          <ContactPicker bare kind="vendor" aria-label="Vendor" placeholder="All vendors" clearable allowCreate={false} value={params.contactId ?? null} onChange={(id) => list.set('contactId', id)} />
          <AccountPicker
            aria-label="Paid from"
            placeholder="Any bank account or card"
            clearable
            allow={isPaymentAccount}
            createType={false}
            value={params.accountId ?? null}
            onChange={(id) => list.set('accountId', id)}
          />
          <Input type="date" aria-label="From date" value={params.from ?? ''} onChange={(e) => list.set('from', e.target.value || null)} />
          <Input type="date" aria-label="To date" value={params.to ?? ''} onChange={(e) => list.set('to', e.target.value || null)} />
          <Select aria-label="Status" value={params.status ?? ''} onChange={(e) => list.set('status', e.target.value || null)}>
            <option value="">All statuses</option>
            <option value="posted">Not voided</option>
            <option value="void">Void</option>
          </Select>
        </div>
      </Card>
      <FilterChips filters={filters} onRemove={(key) => list.clear([key])} onClear={clearAll} />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.items.length === 0 && (
        <EmptyState
          title={filtered ? 'No expenses match these filters' : 'No expenses yet'}
          description={filtered ? 'Try a wider date range or remove a filter.' : 'Record what you paid for and which account it came from.'}
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearAll}>
                Clear filters
              </Button>
            ) : (
              <LinkButton href="/purchases/new">Record expense</LinkButton>
            )
          }
        />
      )}
      {q.data && q.data.items.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
          <Table aria-label="Expenses">
            <THead>
              <TR>
                <SortableTH className="w-28" sortKey="date" {...sortProps}>
                  Date
                </SortableTH>
                <SortableTH sortKey="vendor" defaultDir="asc" {...sortProps}>
                  Vendor
                </SortableTH>
                <SortableTH className="hidden md:table-cell" sortKey="reference" defaultDir="asc" title="Sort by reference" {...sortProps}>
                  Note / reference
                </SortableTH>
                <TH className="hidden lg:table-cell">Paid from</TH>
                <SortableTH numeric sortKey="total" {...sortProps}>
                  Total
                </SortableTH>
                <TH className="w-24">
                  <span className="sr-only">Status</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((p) => (
                <TR key={p.id} href={`/purchases/${p.id}`} onMouseEnter={() => prefetch(p.id)} onFocus={() => prefetch(p.id)}>
                  <TD>{formatDate(p.date)}</TD>
                  <TD>
                    <Link href={`/purchases/${p.id}`} className="font-medium text-brand-700 hover:underline">
                      {p.contactName || '(no vendor)'}
                    </Link>
                    <p className="text-xs text-stone-500 md:hidden">{p.memo || p.reference || ''}</p>
                  </TD>
                  <TD className="hidden md:table-cell">
                    <span>{p.memo || '—'}</span>
                    {p.reference && <p className="text-xs text-stone-500">Ref {p.reference}</p>}
                  </TD>
                  <TD className="hidden lg:table-cell">{p.paidFromAccountName ?? '—'}</TD>
                  <TD numeric>{formatMoney(p.total, cur)}</TD>
                  {/* Only the states worth noticing get a badge; a normal expense has none. */}
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {p.status === 'void' && <Badge tone="neutral">Void</Badge>}
                      {p.direction === 'inflow' && <Badge tone="blue">Refund</Badge>}
                    </span>
                  </TD>
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
            noun="expenses"
            total={q.data.total}
            summary={<span data-testid="purchases-page-total">Net spent {formatMoney(pageNet, cur)}</span>}
          />
        </Card>
      )}
    </>
  );
}
