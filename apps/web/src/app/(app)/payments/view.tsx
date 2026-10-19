'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ListPaymentsQuery, RefundDto, PaymentDto } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/input';
import { SortableTH, Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { useToast } from '@/components/ui/toast';
import { ContactPicker } from '@/components/contact-picker';
import { PAYMENT_METHOD_LABELS, type PaymentMethod, usePayments, usePrefetchPayment, useRefunds, useVoidRefund } from '@/lib/queries/payments';
import { useContact } from '@/lib/queries/contacts';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatMoney, isZeroDecimal } from '@/lib/format';
import { sumDecimals } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { useListParams } from '@/lib/use-list-params';
import { useHotkeys } from '@/lib/use-hotkeys';
import { cn } from '@/lib/utils';
import { ExportCsvButton } from '@/components/export-csv-button';
import { DeleteRecordButton } from '@/components/delete-record-dialog';
import { Term } from '@/components/ui/term';

const PAGE_SIZE = 50;
const FILTER_KEYS = ['q', 'from', 'to', 'status', 'contactId', 'unapplied'];
type PaymentSort = NonNullable<ListPaymentsQuery['sort']>;
const SORT_KEYS: readonly PaymentSort[] = ['date', 'amount', 'customer', 'unapplied'];

export function methodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method as PaymentMethod] ?? method;
}

export function PaymentsListView() {
  const { company } = useCompany();
  const router = useRouter();
  const list = useListParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const tab = list.get('tab') === 'refunds' ? 'refunds' : 'payments';
  const params = {
    contactId: list.get('contactId'),
    from: list.get('from'),
    to: list.get('to'),
    status: list.get('status') as 'posted' | 'void' | undefined,
    unappliedOnly: list.get('unapplied') === '1' ? true : undefined,
    q: list.get('q'),
    // an unknown ?sort= falls back to the default instead of failing the request
    sort: SORT_KEYS.includes(list.sort as PaymentSort) ? (list.sort as PaymentSort) : undefined,
    dir: list.dir,
    cursor: list.cursor,
    limit: PAGE_SIZE,
  };
  const sortProps = { sort: params.sort ?? 'date', dir: params.dir ?? 'desc', onSort: list.setSort } as const;

  const q = usePayments(params);
  const prefetch = usePrefetchPayment();
  const customer = useContact(params.contactId ?? '');
  const cur = company.baseCurrency;

  useHotkeys({
    n: () => router.push('/payments/new'),
    '/': () => searchRef.current?.focus(),
  });

  const filters: ActiveFilter[] = [];
  if (params.q) filters.push({ key: 'q', label: `Search: ${params.q}` });
  if (params.contactId) filters.push({ key: 'contactId', label: `Customer: ${customer.data?.name ?? '…'}` });
  if (params.from) filters.push({ key: 'from', label: `From ${formatDate(params.from)}` });
  if (params.to) filters.push({ key: 'to', label: `To ${formatDate(params.to)}` });
  if (params.status) filters.push({ key: 'status', label: params.status === 'posted' ? 'Not void' : 'Void' });
  if (params.unappliedOnly) filters.push({ key: 'unapplied', label: 'Has credit to use' });
  const filtered = filters.length > 0;
  const clearAll = () => list.clear(FILTER_KEYS);

  const posted = (q.data?.items ?? []).filter((p) => p.status === 'posted');
  const pageReceived = sumDecimals(posted.map((p) => p.amount));
  const pageUnapplied = sumDecimals(posted.map((p) => p.unappliedAmount));

  return (
    <>
      <PageHeader
        title="Payments received"
        description={
          <>
            Money customers paid you and the invoices it went toward. Money not on an invoice yet is <Term id="unapplied">credit to use</Term>: apply it to an invoice or refund it from the payment&rsquo;s page.
          </>
        }
        actions={
          <>
            <ExportCsvButton
              path="/api/payments"
              query={{ ...params, cursor: undefined, limit: undefined }}
              filename="payments.csv"
              columns={[
                { header: 'Date', value: (r: PaymentDto) => r.date },
                { header: 'Customer', value: (r: PaymentDto) => r.contactName },
                { header: 'Method', value: (r: PaymentDto) => r.method },
                { header: 'Reference', value: (r: PaymentDto) => r.reference },
                { header: 'Deposit account', value: (r: PaymentDto) => r.depositAccountName },
                { header: 'Status', value: (r: PaymentDto) => r.status },
                { header: 'Amount', value: (r: PaymentDto) => r.amount },
                { header: 'Applied', value: (r: PaymentDto) => r.amountAllocated },
                { header: 'Unapplied', value: (r: PaymentDto) => r.unappliedAmount },
                { header: 'Memo', value: (r: PaymentDto) => r.memo },
              ]}
            />
            <LinkButton href="/payments/new">Record payment</LinkButton>
          </>
        }
      />
      <nav aria-label="Payments sections" className="mb-4 flex gap-1 border-b border-stone-200">
        {(
          [
            ['payments', 'Payments'],
            ['refunds', 'Refunds'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => list.set('tab', key === 'payments' ? null : key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === key ? 'border-brand-600 text-brand-700' : 'border-transparent text-stone-500 hover:text-stone-800',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'refunds' ? (
        <RefundsTab contactId={params.contactId} />
      ) : (
        <>
          <Card className="mb-4">
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-6">
              <Input
                ref={searchRef}
                type="search"
                aria-label="Search payments"
                placeholder="Search reference or memo…"
                value={list.search}
                onChange={(e) => list.setSearch(e.target.value)}
                className="lg:col-span-2"
              />
              <ContactPicker bare kind="customer" aria-label="Customer" placeholder="All customers" clearable allowCreate={false} value={params.contactId ?? null} onChange={(id) => list.set('contactId', id)} />
              <Input type="date" aria-label="From date" value={params.from ?? ''} onChange={(e) => list.set('from', e.target.value || null)} />
              <Input type="date" aria-label="To date" value={params.to ?? ''} onChange={(e) => list.set('to', e.target.value || null)} />
              <Select aria-label="Status" value={params.status ?? ''} onChange={(e) => list.set('status', e.target.value || null)}>
                <option value="">All payments</option>
                <option value="posted">Not void</option>
                <option value="void">Void</option>
              </Select>
              <div className="flex items-center lg:col-span-6">
                <Checkbox label="Has credit to use" checked={Boolean(params.unappliedOnly)} onChange={(e) => list.set('unapplied', e.target.checked ? '1' : null)} />
              </div>
            </div>
          </Card>
          <FilterChips filters={filters} onRemove={(key) => list.clear([key])} onClear={clearAll} />
          {q.isPending && <Spinner />}
          {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
          {q.data && q.data.items.length === 0 && (
            <EmptyState
              title={filtered ? 'No payments match these filters' : 'No payments yet'}
              description={filtered ? 'Try a wider date range or remove a filter.' : 'Record a customer payment to see it here.'}
              action={
                filtered ? (
                  <Button variant="secondary" onClick={clearAll}>
                    Clear filters
                  </Button>
                ) : (
                  <LinkButton href="/payments/new">Record payment</LinkButton>
                )
              }
            />
          )}
          {q.data && q.data.items.length > 0 && (
            <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
              <Table aria-label="Payments">
                <THead>
                  <TR>
                    <SortableTH className="w-28" sortKey="date" {...sortProps}>
                      Date
                    </SortableTH>
                    <SortableTH sortKey="customer" defaultDir="asc" {...sortProps}>
                      Customer
                    </SortableTH>
                    <TH className="hidden md:table-cell">Method / reference</TH>
                    <TH className="hidden lg:table-cell">Money went to</TH>
                    <SortableTH numeric sortKey="amount" {...sortProps}>
                      Amount
                    </SortableTH>
                    <TH numeric className="hidden sm:table-cell">
                      Applied to invoices
                    </TH>
                    <SortableTH numeric sortKey="unapplied" {...sortProps}>
                      Credit to use
                    </SortableTH>
                    <TH className="w-24">Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {q.data.items.map((p) => {
                    const hasUnapplied = p.status === 'posted' && !isZeroDecimal(p.unappliedAmount);
                    return (
                      <TR key={p.id} href={`/payments/${p.id}`} onMouseEnter={() => prefetch(p.id)} onFocus={() => prefetch(p.id)}>
                        <TD>
                          <Link href={`/payments/${p.id}`} className="font-medium text-brand-700 hover:underline">
                            {formatDate(p.date)}
                          </Link>
                        </TD>
                        <TD>
                          {p.contactId ? (
                            <Link href={`/contacts/${p.contactId}`} className="hover:underline">
                              {p.contactName ?? 'Customer'}
                            </Link>
                          ) : (
                            <span className="text-stone-500">No customer</span>
                          )}
                          <p className="text-xs text-stone-500 md:hidden">
                            {methodLabel(p.method)}
                            {p.reference ? ` · ${p.reference}` : ''}
                          </p>
                        </TD>
                        <TD className="hidden md:table-cell">
                          {methodLabel(p.method)}
                          {p.reference && <span className="text-stone-500"> · {p.reference}</span>}
                        </TD>
                        <TD className="hidden lg:table-cell">{p.depositAccountName ?? '—'}</TD>
                        <TD numeric>{formatMoney(p.amount, cur)}</TD>
                        <TD numeric className="hidden sm:table-cell">
                          {formatMoney(p.amountAllocated, cur)}
                        </TD>
                        <TD numeric className={hasUnapplied ? 'font-semibold text-amber-700' : undefined}>
                          {formatMoney(p.unappliedAmount, cur)}
                        </TD>
                        <TD>
                          {p.status === 'void' && <Badge tone="neutral">Void</Badge>}
                          {p.isRefundableDeposit && (
                            <Badge tone="purple" className="ml-1">
                              Deposit
                            </Badge>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
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
                noun="payments"
                total={q.data.total}
                summary={
                  <span data-testid="payments-page-total">
                    Received {formatMoney(pageReceived, cur)} · Credit to use {formatMoney(pageUnapplied, cur)}
                  </span>
                }
              />
            </Card>
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
function RefundsTab({ contactId }: { contactId?: string }) {
  const { company } = useCompany();
  const q = useRefunds(contactId ? { contactId } : {});
  const cur = company.baseCurrency;

  return (
    <>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState title="No refunds yet" description="To give money back, open a payment that has credit to use, or a credit note, and choose Refund." />}
      {q.data && q.data.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
          <RefundsTable refunds={q.data} currency={cur} />
        </Card>
      )}
    </>
  );
}

/** Shared refunds table with a void action; used on the list tab and the payment detail. */
export function RefundsTable({ refunds, currency, showSource = true }: { refunds: RefundDto[]; currency: string; showSource?: boolean }) {
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const voidRefund = useVoidRefund();
  const [target, setTarget] = React.useState<RefundDto | null>(null);
  const [reason, setReason] = React.useState('');
  const idem = React.useRef(idempotencyKey());

  const close = () => {
    setTarget(null);
    setReason('');
    idem.current = idempotencyKey();
  };

  const submitVoid = () => {
    if (!target || !reason.trim() || voidRefund.isPending) return;
    voidRefund.mutate(
      { id: target.id, reason: reason.trim(), idempotencyKey: idem.current },
      {
        onSuccess: () => {
          toast.success('Refund voided');
          close();
        },
        onError: (e) => onError(e, 'Could not void refund'),
      },
    );
  };

  return (
    <>
      <Table aria-label="Refunds">
        <THead>
          <TR>
            <TH className="w-28">Date</TH>
            {showSource && <TH>Source</TH>}
            <TH className="hidden md:table-cell">Method / reference</TH>
            <TH className="hidden lg:table-cell">Paid from</TH>
            <TH numeric>Amount</TH>
            <TH className="w-24">Status</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {refunds.map((r) => (
            <TR key={r.id}>
              <TD>{formatDate(r.date)}</TD>
              {showSource && (
                <TD>
                  {r.sourceType === 'payment' && r.paymentId ? (
                    <Link href={`/payments/${r.paymentId}`} className="font-medium text-brand-700 hover:underline">
                      Payment
                    </Link>
                  ) : r.creditNoteId ? (
                    <Link href={`/credit-notes/${r.creditNoteId}`} className="font-medium text-brand-700 hover:underline">
                      Credit note
                    </Link>
                  ) : (
                    '—'
                  )}
                </TD>
              )}
              <TD className="hidden md:table-cell">
                {methodLabel(r.method)}
                {r.reference && <span className="text-stone-500"> · {r.reference}</span>}
              </TD>
              <TD className="hidden lg:table-cell">{r.fromAccountName ?? '—'}</TD>
              <TD numeric>{formatMoney(r.amount, currency)}</TD>
              <TD>{r.status === 'void' && <Badge tone="neutral">Void</Badge>}</TD>
              <TD className="text-right">
                <div className="flex justify-end gap-2">
                  {r.status === 'posted' && (
                    <Button variant="ghost" size="sm" onClick={() => setTarget(r)}>
                      Void…
                    </Button>
                  )}
                  <DeleteRecordButton type="refund" id={r.id} variant="ghost" size="sm" />
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <Dialog
        open={target !== null}
        onClose={close}
        onSubmit={submitVoid}
        dirty={!!reason.trim() && !voidRefund.isPending}
        title="Void refund"
        description="The refund stays in your records marked Void, and the money counts as credit again on its payment or credit note."
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={voidRefund.isPending}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" loading={voidRefund.isPending} disabled={!reason.trim()}>
              Void refund
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="void-refund-reason" required>
          <Textarea id="void-refund-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
      </Dialog>
    </>
  );
}
