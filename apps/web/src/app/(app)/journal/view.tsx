'use client';
import * as React from 'react';
import type { JournalEntryDto } from '@evenbooks/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { SortableTH, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { AccountPicker, accountLabel } from '@/components/account-picker';
import { CASH_TREATMENT_LABEL, journalSourceLabel, useJournalList, usePrefetchJournalEntry } from '@/lib/queries/journal';
import { useAccounts } from '@/lib/queries/accounts';
import { formatDate, formatMoney, capitalize } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { ExportCsvButton } from '@/components/export-csv-button';

const PAGE_SIZE = 50;
const FILTER_KEYS = ['q', 'from', 'to', 'status', 'accountId', 'sourceType'];

export function JournalListView() {
  const { company } = useCompany();
  const router = useRouter();
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const params = {
    from: list.get('from'),
    to: list.get('to'),
    status: list.get('status') as 'draft' | 'posted' | undefined,
    accountId: list.get('accountId'),
    sourceType: list.get('sourceType'),
    q: list.get('q'),
    sort: list.sort as 'date' | 'number' | undefined,
    dir: list.dir,
    cursor: list.cursor,
    limit: PAGE_SIZE,
  };
  const sortProps = { sort: params.sort ?? 'date', dir: params.dir ?? 'desc', onSort: list.setSort } as const;

  const q = useJournalList(params);
  const accounts = useAccounts({ includeArchived: true });
  const prefetch = usePrefetchJournalEntry();

  useHotkeys({
    n: () => router.push('/journal/new'),
    '/': () => searchRef.current?.focus(),
  });

  const account = params.accountId ? (accounts.data ?? []).find((a) => a.id === params.accountId) : undefined;
  const filters: ActiveFilter[] = [];
  if (params.q) filters.push({ key: 'q', label: `Search: ${params.q}` });
  if (params.accountId) filters.push({ key: 'accountId', label: `Account: ${account ? accountLabel(account) : '…'}` });
  if (params.sourceType) filters.push({ key: 'sourceType', label: `Source: ${journalSourceLabel(params.sourceType)}` });
  if (params.from) filters.push({ key: 'from', label: `From ${formatDate(params.from)}` });
  if (params.to) filters.push({ key: 'to', label: `To ${formatDate(params.to)}` });
  if (params.status) filters.push({ key: 'status', label: capitalize(params.status) });
  const filtered = filters.length > 0;
  const clearAll = () => list.clear(FILTER_KEYS);

  return (
    <>
      <PageHeader
        title="Journal entries"
        description="Manual adjustments to your books. Most businesses rarely need these: invoices, expenses and bank transactions record themselves."
        actions={
          <>
            <ExportCsvButton
              path="/api/journal"
              query={{ ...params, cursor: undefined, limit: undefined }}
              filename="journal-entries.csv"
              columns={[
                { header: 'Entry', value: (r: JournalEntryDto) => r.entryNumber },
                { header: 'Date', value: (r: JournalEntryDto) => r.date },
                { header: 'Memo', value: (r: JournalEntryDto) => r.memo },
                { header: 'Source', value: (r: JournalEntryDto) => r.sourceType },
                { header: 'Status', value: (r: JournalEntryDto) => r.status },
                { header: 'Debits', value: (r: JournalEntryDto) => r.totalDebit },
                { header: 'Credits', value: (r: JournalEntryDto) => r.totalCredit },
              ]}
            />
            <LinkButton href="/journal/new">New manual entry</LinkButton>
          </>
        }
      />
      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
          <Input ref={searchRef} type="search" aria-label="Search memo" placeholder="Search memo…" value={list.search} onChange={(e) => list.setSearch(e.target.value)} />
          <Input type="date" aria-label="From date" value={params.from ?? ''} onChange={(e) => list.set('from', e.target.value || null)} />
          <Input type="date" aria-label="To date" value={params.to ?? ''} onChange={(e) => list.set('to', e.target.value || null)} />
          <Select aria-label="Status" value={params.status ?? ''} onChange={(e) => list.set('status', e.target.value || null)}>
            <option value="">All statuses</option>
            <option value="posted">Saved</option>
            <option value="draft">Draft</option>
          </Select>
          <AccountPicker aria-label="Account" placeholder="All accounts" clearable createType={false} value={params.accountId ?? null} onChange={(id) => list.set('accountId', id)} />
        </div>
      </Card>
      <FilterChips filters={filters} onRemove={(key) => list.clear([key])} onClear={clearAll} />
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.items.length === 0 && (
        <EmptyState
          title="No journal entries match"
          description={filtered ? 'Try a wider date range or remove a filter.' : undefined}
          action={
            filtered ? (
              <Button variant="secondary" onClick={clearAll}>
                Clear filters
              </Button>
            ) : (
              <LinkButton href="/journal/new">New manual entry</LinkButton>
            )
          }
        />
      )}
      {q.data && q.data.items.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
          <Table aria-label="Journal entries">
            <THead>
              <TR>
                <SortableTH className="w-16" sortKey="number" {...sortProps}>
                  #
                </SortableTH>
                <SortableTH className="w-28" sortKey="date" {...sortProps}>
                  Date
                </SortableTH>
                <TH>Memo</TH>
                <TH className="hidden md:table-cell">Source</TH>
                <TH className="hidden lg:table-cell">On cash reports</TH>
                <TH numeric>Amount</TH>
                <TH className="w-24">Status</TH>
              </TR>
            </THead>
            <TBody>
              {q.data.items.map((e) => (
                <TR key={e.id} href={`/journal/${e.id}`} onMouseEnter={() => prefetch(e.id)} onFocus={() => prefetch(e.id)}>
                  <TD className="font-mono text-xs">{e.entryNumber ?? '—'}</TD>
                  <TD>{formatDate(e.date)}</TD>
                  <TD>
                    <Link href={`/journal/${e.id}`} className="font-medium text-brand-700 hover:underline">
                      {e.memo || '(no memo)'}
                    </Link>
                    <p className="text-xs text-stone-500 md:hidden">{journalSourceLabel(e.sourceType)}</p>
                  </TD>
                  <TD className="hidden md:table-cell">{journalSourceLabel(e.sourceType)}</TD>
                  <TD className="hidden text-stone-600 lg:table-cell">{CASH_TREATMENT_LABEL[e.cashTreatment] ?? capitalize(e.cashTreatment)}</TD>
                  <TD numeric>{formatMoney(e.totalDebit, company.baseCurrency)}</TD>
                  <TD>
                    {/* Only states worth acting on get a badge; saved entries are the norm. */}
                    {e.status === 'draft' && <Badge tone="neutral">Draft</Badge>}
                    {e.reversedByEntryId && (
                      <Badge tone="red" className="ml-1">
                        Reversed
                      </Badge>
                    )}
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
            noun="entries"
            total={q.data.total}
          />
        </Card>
      )}
    </>
  );
}
