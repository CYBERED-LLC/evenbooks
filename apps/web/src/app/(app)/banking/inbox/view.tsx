'use client';
import * as React from 'react';
import Link from 'next/link';
import { Keyboard, Sparkles } from 'lucide-react';
import type { BankTransactionDto, BankTxnStatus } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { DateInput } from '@/components/ui/date-input';
import { MoneyInput } from '@/components/ui/money-input';
import { FilterChips, Pager, type ActiveFilter } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { Term } from '@/components/ui/term';
import { useBankAccountsForInbox, useBankTransaction, useBulkReview, useCategorizeTransaction, useInbox, useUndoReview, type InboxParams } from '@/lib/queries/inbox';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import { parseDecimalInput } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { useHotkeys } from '@/lib/use-hotkeys';
import { useListParams } from '@/lib/use-list-params';
import { cn } from '@/lib/utils';
import { ReviewDialog, type ReviewDone, type ReviewTarget } from './review-dialog';
import { BulkBar } from './bulk';
import { absDecimal, InboxActionsContext, isMoneyIn, needsMatch, STATUS_LABEL, type InboxActions } from './shared';
import { TransactionDialog } from './transaction-dialog';

const STATUS_TABS: { value: BankTxnStatus; label: string }[] = [
  { value: 'unreviewed', label: 'For review' },
  { value: 'categorized', label: 'Categorized' },
  { value: 'matched', label: 'Matched' },
  { value: 'transfer', label: 'Transfers' },
  { value: 'excluded', label: 'Excluded' },
];

const STATUS_TONE: Record<BankTxnStatus, 'amber' | 'green' | 'blue' | 'purple' | 'neutral'> = {
  unreviewed: 'amber',
  categorized: 'green',
  matched: 'blue',
  transfer: 'purple',
  excluded: 'neutral',
};

const PAGE_SIZE = 50;
const FILTER_KEYS = ['bankAccountId', 'q', 'from', 'to', 'amountMin', 'amountMax'] as const;
/** Links into the inbox can open one line: `/banking/inbox?transactionId=<id>`. */
const LINK_KEY = 'transactionId';

function isStatus(v: string | undefined): v is BankTxnStatus {
  return STATUS_TABS.some((t) => t.value === v);
}

const ROW_INTERACTIVE = 'a, button, input, select, textarea, label, [role="combobox"], [data-row-click="ignore"]';

export function InboxView() {
  const { company } = useCompany();
  const cur = company.baseCurrency;
  const lp = useListParams();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const statusParam = lp.get('status');
  const status: BankTxnStatus = isStatus(statusParam) ? statusParam : 'unreviewed';
  const params: InboxParams = {
    bankAccountId: lp.get('bankAccountId'),
    status,
    from: lp.get('from'),
    to: lp.get('to'),
    q: lp.get('q'),
    amountMin: lp.get('amountMin'),
    amountMax: lp.get('amountMax'),
    cursor: lp.cursor,
    limit: PAGE_SIZE,
  };
  const q = useInbox(params);
  const bankAccounts = useBankAccountsForInbox();
  const items = React.useMemo(() => q.data?.items ?? [], [q.data]);
  const counts = q.data?.counts ?? {};
  const reviewable = status === 'unreviewed';

  const [target, setTarget] = React.useState<ReviewTarget | null>(null);
  const [viewing, setViewing] = React.useState<BankTransactionDto | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [focusIndex, setFocusIndex] = React.useState(-1);
  // Lines reviewed from this screen; the list snapshot may still show them until the refetch lands.
  const reviewedIds = React.useRef(new Set<string>());
  const refocusRow = React.useRef(false);
  const tbodyRef = React.useRef<HTMLDivElement>(null);

  // A new filter, tab or page starts with nothing selected.
  const listKey = JSON.stringify(params);
  React.useEffect(() => {
    setSelected(new Set());
    setFocusIndex(-1);
  }, [listKey]);

  const focusRow = React.useCallback((i: number) => {
    const el = tbodyRef.current?.querySelector<HTMLElement>(`tr[data-row-index="${i}"]`);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  // After a row action the row disappears; keep the keyboard on the same position.
  React.useEffect(() => {
    if (!refocusRow.current || q.isPlaceholderData) return;
    refocusRow.current = false;
    if (items.length === 0) return;
    const i = Math.min(Math.max(focusIndex, 0), items.length - 1);
    setFocusIndex(i);
    focusRow(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // --- single-line actions -------------------------------------------------
  const undo = useUndoReview();
  const bulk = useBulkReview();
  const actions = React.useMemo<InboxActions>(
    () => ({
      undoOne: (t) =>
        undo.mutate(
          { id: t.id, input: { version: t.version, idempotencyKey: idempotencyKey() } },
          {
            onSuccess: () => {
              reviewedIds.current.delete(t.id);
              toast.success('Review undone', 'The transaction is back in For review.');
            },
            onError: (e) => onError(e, 'Could not undo review'),
          },
        ),
      undoMany: (txns) =>
        bulk.mutate(
          { action: 'undo', items: txns.map((t) => ({ id: t.id, version: t.version })), idempotencyKey: idempotencyKey() },
          {
            onSuccess: (res) => {
              txns.forEach((t) => reviewedIds.current.delete(t.id));
              if (res.failed > 0) toast.error(`${res.failed} could not be undone`, res.results.find((r) => !r.ok)?.error?.message);
              else toast.success(res.succeeded === 1 ? 'Review undone' : `${res.succeeded} reviews undone`, 'Back in For review.');
            },
            onError: (e) => onError(e, 'Could not undo'),
          },
        ),
    }),
    // mutate functions are stable; toast/onError are stable providers
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const categorize = useCategorizeTransaction();
  const acceptKeys = React.useRef(new Map<string, string>());
  const [accepting, setAccepting] = React.useState<string | null>(null);
  const accept = (t: BankTransactionDto) => {
    const s = t.suggestion;
    if (!s || accepting) return;
    // Probably recorded already: accepting would count it twice, so match it instead.
    if (needsMatch(t)) return openReview(t, 'match');
    const k = `${t.id}:${t.version}`;
    if (!acceptKeys.current.has(k)) acceptKeys.current.set(k, idempotencyKey());
    setAccepting(t.id);
    refocusRow.current = true;
    categorize.mutate(
      {
        id: t.id,
        input: {
          version: t.version,
          contactId: s.contactId ?? null,
          memo: s.memo ?? null,
          lines: [{ accountId: s.accountId, amount: absDecimal(t.amount), description: '' }],
          idempotencyKey: acceptKeys.current.get(k)!,
        },
      },
      {
        onSuccess: (res) => {
          reviewedIds.current.add(t.id);
          toast.success(`Categorized to ${s.accountName}`, undefined, { action: { label: 'Undo', onClick: () => actions.undoOne(res) } });
        },
        onError: (e) => {
          refocusRow.current = false;
          onError(e, 'Could not categorize');
        },
        onSettled: () => setAccepting(null),
      },
    );
  };

  // --- review dialog and "next" -------------------------------------------
  const nextAfter = React.useCallback(
    (doneId: string, extra: string[] = []) => {
      const skip = new Set([doneId, ...extra, ...reviewedIds.current]);
      const ok = (t: BankTransactionDto) => t.status === 'unreviewed' && !skip.has(t.id);
      const idx = items.findIndex((t) => t.id === doneId);
      return items.slice(idx + 1).find(ok) ?? items.slice(0, Math.max(idx, 0)).reverse().find(ok) ?? null;
    },
    [items],
  );
  // A link to one line opens it: the review dialog while it waits for review,
  // otherwise its details, on the tab that lists it.
  const linkedId = lp.get(LINK_KEY);
  const linked = useBankTransaction(linkedId);
  const openedLink = React.useRef<string | null>(null);
  React.useEffect(() => {
    const t = linked.data;
    if (!t || t.id !== linkedId || openedLink.current === t.id) return;
    openedLink.current = t.id;
    if (status !== t.status) lp.setMany({ status: t.status === 'unreviewed' ? null : t.status }, true);
    if (t.status === 'unreviewed') setTarget({ txn: t });
    else setViewing(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked.data, linkedId]);
  const openReview = (t: BankTransactionDto, mode?: ReviewTarget['mode']) => {
    const i = items.findIndex((x) => x.id === t.id);
    if (i >= 0) setFocusIndex(i);
    setTarget({ txn: t, mode });
  };
  const closeReview = () => {
    setTarget(null);
    refocusRow.current = true;
    if (linkedId) lp.setMany({ [LINK_KEY]: null }, false);
  };
  const closeViewing = () => {
    setViewing(null);
    if (linkedId) lp.setMany({ [LINK_KEY]: null }, false);
  };

  const onReviewed: ReviewDone = (result, next, alsoReviewed = []) => {
    reviewedIds.current.add(result.id);
    alsoReviewed.forEach((id) => reviewedIds.current.add(id));
    setSelected((prev) => {
      if (!prev.has(result.id)) return prev;
      const n = new Set(prev);
      n.delete(result.id);
      return n;
    });
    const following = next ? nextAfter(result.id, alsoReviewed) : null;
    if (following) {
      const i = items.findIndex((x) => x.id === following.id);
      if (i >= 0) setFocusIndex(i);
      setTarget({ txn: following });
    } else closeReview();
  };
  const hasNext = target ? nextAfter(target.txn.id) !== null : false;

  // --- selection ------------------------------------------------------------
  const selectable = reviewable ? items.filter((t) => t.status === 'unreviewed' && !reviewedIds.current.has(t.id)) : [];
  const selectedTxns = selectable.filter((t) => selected.has(t.id));
  const allSelected = selectable.length > 0 && selectedTxns.length === selectable.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const suggestedOnPage = selectable.filter((t) => t.suggestion);
  const allTransactions = Object.values(counts).reduce((a, n) => a + (n ?? 0), 0);
  // No bank account yet, or nothing ever imported into the one shown: say how to bring transactions in.
  const noBankData = bankAccounts.isSuccess && (bankAccounts.data.length === 0 || allTransactions === 0);

  // --- keyboard -------------------------------------------------------------
  const move = (delta: number) => {
    if (items.length === 0) return;
    const i = Math.min(Math.max((focusIndex < 0 ? (delta > 0 ? -1 : items.length) : focusIndex) + delta, 0), items.length - 1);
    setFocusIndex(i);
    focusRow(i);
  };
  const focused = focusIndex >= 0 ? items[focusIndex] : undefined;
  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    r: () => {
      if (focused?.status === 'unreviewed') openReview(focused);
    },
    e: () => {
      if (focused?.status === 'unreviewed') openReview(focused, 'exclude');
    },
    x: () => {
      if (focused && reviewable && focused.status === 'unreviewed') toggle(focused.id);
    },
  });

  const onRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, t: BankTransactionDto) => {
    if (e.target !== e.currentTarget || e.key !== 'Enter' || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    if (t.status !== 'unreviewed') return setViewing(t);
    if (needsMatch(t)) openReview(t, 'match');
    else if (t.suggestion) accept(t);
    else openReview(t);
  };
  const onRowClick = (e: React.MouseEvent<HTMLTableRowElement>, t: BankTransactionDto, i: number) => {
    setFocusIndex(i);
    if ((e.target as HTMLElement).closest(ROW_INTERACTIVE) || window.getSelection()?.toString()) return;
    if (t.status === 'unreviewed') openReview(t);
    else setViewing(t);
  };

  // --- filters --------------------------------------------------------------
  const bankName = (id: string) => (bankAccounts.data ?? []).find((b) => b.id === id)?.name ?? 'Bank account';
  const chips: ActiveFilter[] = [];
  if (params.bankAccountId) chips.push({ key: 'bankAccountId', label: bankName(params.bankAccountId) });
  if (params.q) chips.push({ key: 'q', label: `Search: ${params.q}` });
  if (params.from) chips.push({ key: 'from', label: `From ${formatDate(params.from)}` });
  if (params.to) chips.push({ key: 'to', label: `To ${formatDate(params.to)}` });
  if (params.amountMin) chips.push({ key: 'amountMin', label: `At least ${formatMoney(params.amountMin, cur)}` });
  if (params.amountMax) chips.push({ key: 'amountMax', label: `At most ${formatMoney(params.amountMax, cur)}` });

  // Only the bank account is a "view", not a narrowing filter, for the empty state.
  const narrowed = chips.some((c) => c.key !== 'bankAccountId');
  const total = counts[status] ?? 0;
  const suggestedCount = q.data?.suggestedCount ?? 0;

  return (
    <InboxActionsContext.Provider value={actions}>
      <PageHeader
        title="Bank transactions"
        description="New activity from your bank and card accounts waits here. Say what each one was for, and it’s recorded in your books."
      />
      <Card className="mb-4">
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-12">
          <Select aria-label="Bank account" className="lg:col-span-2" value={params.bankAccountId ?? ''} onChange={(e) => lp.set('bankAccountId', e.target.value || null)}>
            <option value="">All bank accounts</option>
            {(bankAccounts.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Input
            type="search"
            aria-label="Search transactions"
            className="lg:col-span-3"
            placeholder="Search description, payee, memo or amount…"
            value={lp.search}
            onChange={(e) => lp.setSearch(e.target.value)}
          />
          <DateInput aria-label="From date" className="lg:col-span-2" value={params.from ?? ''} onChange={(v) => lp.set('from', v || null)} />
          <DateInput aria-label="To date" className="lg:col-span-2" value={params.to ?? ''} onChange={(v) => lp.set('to', v || null)} />
          <div className="flex gap-2 lg:col-span-3">
            <AmountFilter label="Minimum amount" placeholder="Min $" value={params.amountMin} onCommit={(v) => lp.set('amountMin', v)} />
            <AmountFilter label="Maximum amount" placeholder="Max $" value={params.amountMax} onCommit={(v) => lp.set('amountMax', v)} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 px-3 py-2">
          <div role="tablist" aria-label="Review status" className="flex flex-wrap gap-1">
            {STATUS_TABS.map((t) => {
              const active = status === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => lp.set('status', t.value)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    active ? 'bg-brand-600 text-white' : 'text-stone-700 hover:bg-stone-100',
                  )}
                >
                  {t.label}
                  <span className={cn('rounded-full px-1.5 text-xs tabular', active ? 'bg-white/20' : 'bg-stone-100 text-stone-600')}>{counts[t.value] ?? 0}</span>
                </button>
              );
            })}
          </div>
          {reviewable && suggestedCount > 0 && (
            <div className="flex items-center gap-2 text-sm text-stone-700" data-testid="suggestion-summary">
              <Sparkles className="size-4 text-amber-600" aria-hidden />
              <span>{suggestedCount} with suggestions</span>
              {suggestedOnPage.length > 0 && (
                <Button size="sm" variant="link" onClick={() => setSelected(new Set(suggestedOnPage.map((t) => t.id)))}>
                  Select {suggestedOnPage.length === selectable.length ? 'all' : suggestedOnPage.length} on this page
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>

      <FilterChips filters={chips} onRemove={(key) => lp.clear([key])} onClear={() => lp.clear([...FILTER_KEYS])} />

      {q.isPending && <Spinner />}
      {q.isError && <ErrorNotice error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && reviewable && !narrowed && noBankData && (
        <EmptyState
          title="No bank transactions yet"
          description="Connect your bank to bring transactions in every day, or upload a statement file (CSV) from your bank’s website."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <LinkButton href="/banking">Connect your bank</LinkButton>
              <LinkButton href="/banking/import" variant="secondary">
                Upload a statement
              </LinkButton>
            </div>
          }
        />
      )}
      {q.data && items.length === 0 && reviewable && !narrowed && !noBankData && (
        <EmptyState
          title="All caught up"
          description="New bank transactions will show up here to review."
          action={
            <Button variant="secondary" size="sm" onClick={() => lp.set('status', 'categorized')}>
              See categorized transactions
            </Button>
          }
        />
      )}
      {q.data && items.length === 0 && (!reviewable || narrowed) && (
        <EmptyState title="No transactions match" description={narrowed ? 'Try removing a filter.' : undefined} />
      )}
      {q.data && items.length > 0 && (
        <Card className={q.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined} aria-busy={q.isPlaceholderData}>
          {reviewable && <BulkBar selected={selectedTxns} onClear={() => setSelected(new Set())} onSettled={(ids) => {
            ids.forEach((id) => reviewedIds.current.add(id));
            setSelected((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
          }} />}
          <div ref={tbodyRef}>
            <Table aria-label="Bank transactions" stickyHeader>
              <THead>
                <TR>
                  {reviewable && (
                    <TH className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        className="size-4 rounded border-stone-300"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = selectedTxns.length > 0 && !allSelected;
                        }}
                        onChange={() => setSelected(allSelected ? new Set() : new Set(selectable.map((t) => t.id)))}
                      />
                    </TH>
                  )}
                  <TH className="hidden w-28 sm:table-cell">Date</TH>
                  <TH>Description</TH>
                  <TH className="hidden md:table-cell">Bank account</TH>
                  <TH numeric>Amount</TH>
                  <TH className="hidden sm:table-cell">Status</TH>
                  <TH className="hidden sm:table-cell">
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {items.map((t, i) => {
                  const open = t.status === 'unreviewed';
                  const isSel = selected.has(t.id);
                  return (
                    <TR
                      key={t.id}
                      data-testid="txn-row"
                      data-row-index={i}
                      tabIndex={focusIndex === i || (focusIndex < 0 && i === 0) ? 0 : -1}
                      onFocus={(e) => e.target === e.currentTarget && setFocusIndex(i)}
                      onKeyDown={(e) => onRowKeyDown(e, t)}
                      onClick={(e) => onRowClick(e, t, i)}
                      className={cn(
                        'outline-none focus-visible:bg-brand-50 focus-visible:shadow-[inset_3px_0_0_var(--color-brand-600)]',
                        'cursor-pointer',
                        isSel && 'bg-brand-50/60',
                      )}
                    >
                      {reviewable && (
                        <TD data-row-click="ignore" className="w-10">
                          {open && (
                            <input
                              type="checkbox"
                              aria-label={`Select ${t.description}`}
                              className="size-4 rounded border-stone-300"
                              checked={isSel}
                              onChange={() => toggle(t.id)}
                            />
                          )}
                        </TD>
                      )}
                      <TD className="hidden whitespace-nowrap sm:table-cell">{formatDate(t.date)}</TD>
                      <TD>
                        <span className="font-medium">{t.description}</span>
                        <RowBadges txn={t} />
                        {(t.payee || t.memo) && (
                          <p className="text-xs text-stone-500">
                            {t.payee}
                            {t.payee && t.memo ? ' · ' : ''}
                            {t.memo}
                          </p>
                        )}
                        {t.status === 'excluded' && t.excludedReason && <p className="text-xs text-stone-500">Excluded: {t.excludedReason}</p>}
                        {/* Phones drop the date and bank account columns; show them under the description. */}
                        <p className="text-xs text-stone-500 md:hidden">
                          <span className="sm:hidden">{formatDate(t.date)} · </span>
                          {t.bankAccountName}
                        </p>
                        {t.suggestion && (
                          <p className="text-xs text-stone-600 sm:hidden">
                            Suggested: <span className="font-medium text-stone-800">{t.suggestion.accountName}</span>
                          </p>
                        )}
                      </TD>
                      <TD className="hidden md:table-cell">{t.bankAccountName}</TD>
                      <TD numeric className={isMoneyIn(t.amount) ? 'font-medium text-emerald-700' : undefined}>
                        {formatMoney(t.amount, cur)}
                        {open && needsMatch(t) && (
                          <Button size="sm" className="mt-1 sm:hidden" aria-label={`Match ${t.description}`} onClick={() => openReview(t, 'match')}>
                            Match
                          </Button>
                        )}
                        {open && t.suggestion && !needsMatch(t) && (
                          <Button
                            size="sm"
                            className="mt-1 sm:hidden"
                            loading={accepting === t.id}
                            disabled={!!accepting && accepting !== t.id}
                            aria-label={`Accept suggestion ${t.suggestion.accountName} for ${t.description}`}
                            onClick={() => accept(t)}
                          >
                            Accept
                          </Button>
                        )}
                      </TD>
                      <TD className="hidden sm:table-cell">
                        <Badge tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                      </TD>
                      <TD className="hidden sm:table-cell">
                        {open ? (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {needsMatch(t) ? (
                              <Button size="sm" onClick={() => openReview(t, 'match')} aria-label={`Match ${t.description}`}>
                                Match
                              </Button>
                            ) : (
                              t.suggestion && (
                                <>
                                  <span className="text-xs text-stone-600">
                                    Suggested: <span className="font-medium text-stone-800">{t.suggestion.accountName}</span>
                                  </span>
                                  <Button
                                    size="sm"
                                    loading={accepting === t.id}
                                    disabled={!!accepting && accepting !== t.id}
                                    aria-label={`Accept suggestion ${t.suggestion.accountName} for ${t.description}`}
                                    onClick={() => accept(t)}
                                  >
                                    Accept
                                  </Button>
                                </>
                              )
                            )}
                            <Button size="sm" variant="secondary" onClick={() => openReview(t)} aria-label={`Review ${t.description}`}>
                              Review
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            {t.journalEntryId && (
                              <Link href={`/journal/${t.journalEntryId}`} className="text-sm font-medium text-brand-700 hover:underline">
                                Journal entry
                              </Link>
                            )}
                          </div>
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <Pager
            count={items.length}
            pageIndex={lp.pageIndex}
            pageSize={PAGE_SIZE}
            hasPrev={lp.hasPrev}
            hasNext={!!q.data.nextCursor}
            onPrev={lp.prev}
            onNext={() => q.data?.nextCursor && lp.next(q.data.nextCursor)}
            noun={`of ${total} transactions`}
          />
        </Card>
      )}
      {items.length > 0 && <ShortcutHint reviewable={reviewable} />}

      <ReviewDialog target={target} hasNext={hasNext} onClose={closeReview} onDone={onReviewed} />
      <TransactionDialog txn={viewing} onClose={closeViewing} />
    </InboxActionsContext.Provider>
  );
}

function RowBadges({ txn }: { txn: BankTransactionDto }) {
  const h = txn.status === 'unreviewed' ? txn.matchHint : null;
  const found = !!h && (h.count > 0 || h.invoices > 0);
  if (!txn.pending && !found && !h?.transfers) return null;
  return (
    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
      {txn.pending && (
        <Badge tone="amber" className="text-[11px]">
          Pending
        </Badge>
      )}
      {found && (
        <Term id="match-found">
          <Badge tone="blue" className="text-[11px]">
            {h.count === 0 ? 'Unpaid invoice found' : 'Match found'}
          </Badge>
        </Term>
      )}
      {!!h?.transfers && !found && (
        <Term id="possible-transfer">
          <Badge tone="purple" className="text-[11px]">
            Possible transfer
          </Badge>
        </Term>
      )}
    </span>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-stone-300 bg-white px-1 font-mono text-[11px] text-stone-700">{children}</kbd>;
}

function ShortcutHint({ reviewable }: { reviewable: boolean }) {
  return (
    <p className="mt-2 hidden items-center gap-2 text-xs text-stone-500 md:flex" aria-label="Inbox keyboard shortcuts">
      <Keyboard className="size-3.5" aria-hidden />
      <span>
        <Kbd>j</Kbd>/<Kbd>k</Kbd> move
      </span>
      {reviewable && (
        <>
          <span>
            <Kbd>Enter</Kbd> accept suggestion, match or review
          </span>
          <span>
            <Kbd>r</Kbd> review
          </span>
          <span>
            <Kbd>e</Kbd> exclude
          </span>
          <span>
            <Kbd>x</Kbd> select
          </span>
        </>
      )}
    </p>
  );
}

/** Amount bound that only reaches the URL once it parses, on blur or Enter. */
function AmountFilter({ label, placeholder, value, onCommit }: { label: string; placeholder: string; value: string | undefined; onCommit: (v: string | null) => void }) {
  const [text, setText] = React.useState(value ?? '');
  React.useEffect(() => setText(value ?? ''), [value]);
  const commit = () => {
    const parsed = text.trim() ? parseDecimalInput(text) : null;
    if (text.trim() && parsed === null) return;
    if ((parsed ?? undefined) !== value) onCommit(parsed);
  };
  return (
    <MoneyInput
      aria-label={label}
      placeholder={placeholder}
      className="min-w-0"
      value={text}
      onChange={setText}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}
