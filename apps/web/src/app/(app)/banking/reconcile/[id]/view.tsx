'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Plus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReconciliationDetailDto, ReconciliationLineDto } from '@evenbooks/contracts';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { BackLink } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  useBankAccounts,
  useCompleteReconciliation,
  useDeleteReconciliation,
  useReconciliation,
  useReconciliationToggles,
  useReopenReconciliation,
} from '@/lib/queries/reconciliation';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { compareDecimals, negateDecimal, subtractDecimals, sumDecimals } from '@/lib/decimal';
import { capitalize, formatDate, formatDateTime, formatMoney, isZeroDecimal } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { cn } from '@/lib/utils';
import { ReconciliationStatusBadge } from '../view';

type ShowFilter = 'all' | 'uncleared' | 'cleared';
type SortOrder = 'date' | 'date_desc' | 'amount_desc' | 'amount_asc';

function lineLabel(l: ReconciliationLineDto): string {
  return l.entryNumber ? `entry #${l.entryNumber}` : l.memo || 'line';
}

const byDate = (a: ReconciliationLineDto, b: ReconciliationLineDto) => a.date.localeCompare(b.date) || (a.entryNumber ?? 0) - (b.entryNumber ?? 0);
const SORTS: Record<SortOrder, (a: ReconciliationLineDto, b: ReconciliationLineDto) => number> = {
  date: byDate,
  date_desc: (a, b) => byDate(b, a),
  amount_desc: (a, b) => compareDecimals(b.amount, a.amount) || byDate(a, b),
  amount_asc: (a, b) => compareDecimals(a.amount, b.amount) || byDate(a, b),
};

export function ReconcileDetailView({ id }: { id: string }) {
  const { company } = useCompany();
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const onError = useMutationErrorHandler();
  const q = useReconciliation(id);
  const bankAccounts = useBankAccounts();
  const toggles = useReconciliationToggles(id, { onError: (err) => onError(err, 'Could not update cleared items') });
  const complete = useCompleteReconciliation(id);
  const reopen = useReopenReconciliation(id);
  const del = useDeleteReconciliation();
  const idem = React.useRef(idempotencyKey());
  const [show, setShow] = React.useState<ShowFilter>('all');
  const [sort, setSort] = React.useState<SortOrder>('date');
  const [search, setSearch] = React.useState('');
  const [reopening, setReopening] = React.useState(false);
  const [reason, setReason] = React.useState('');
  // Last checkbox clicked without Shift: the start of a Shift-click range.
  const anchor = React.useRef<string | null>(null);

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const cur = company.baseCurrency;
  const editable = r.status === 'in_progress';
  const saving = toggles.saving;
  const listHref = `/banking/reconcile?bankAccountId=${encodeURIComponent(r.bankAccountId)}`;
  const bankAccount = bankAccounts.data?.find((a) => a.id === r.bankAccountId);
  const ledgerAccountId = bankAccount?.ledgerAccountId;
  // On a card a positive amount adds to what is owed (a charge); on a bank account it is money in.
  const isCard = bankAccount?.kind === 'credit_card';
  const sides = isCard ? { up: 'Charges', down: 'Payments and credits' } : { up: 'Deposits', down: 'Withdrawals' };

  // Queued ticks show at once, and the totals follow them; the server's figures take over as each batch saves.
  const isCleared = (l: ReconciliationLineDto) => toggles.pending.get(l.journalLineId) ?? l.cleared;
  const clearedLines = r.lines.filter(isCleared);
  const ups = clearedLines.filter((l) => compareDecimals(l.amount, '0') > 0);
  const downs = clearedLines.filter((l) => compareDecimals(l.amount, '0') < 0);
  const clearedBalance = editable ? sumDecimals([r.statementOpeningBalance, ...clearedLines.map((l) => l.amount)]) : r.clearedBalance;
  const difference = editable ? subtractDecimals(r.statementClosingBalance, clearedBalance) : r.discrepancy;
  const balanced = isZeroDecimal(difference);
  const negDifference = negateDecimal(difference);

  /** Why a line stands out: ticking or unticking it alone would balance, or it is the difference with the sign flipped. */
  const matchHint = (l: ReconciliationLineDto, cleared: boolean): string | null => {
    if (!editable || balanced) return null;
    if (!cleared && compareDecimals(l.amount, difference) === 0) return 'Ticking this makes it match the statement';
    if (cleared && compareDecimals(l.amount, negDifference) === 0) return 'Unticking this makes it match the statement';
    if (!cleared && compareDecimals(l.amount, negDifference) === 0) return 'Same amount as the difference, the other way round: check whether it is money in or money out';
    return null;
  };

  const term = search.trim().toLowerCase();
  const amountTerm = term.replace(/[$,\s]/g, '');
  const visible = r.lines
    .filter((l) => {
      const cleared = isCleared(l);
      if (show === 'cleared' && !cleared) return false;
      if (show === 'uncleared' && cleared) return false;
      if (!term) return true;
      return (
        l.memo.toLowerCase().includes(term) ||
        String(l.entryNumber ?? '').includes(term) ||
        (amountTerm !== '' && l.amount.includes(amountTerm)) ||
        l.sourceType.toLowerCase().includes(term) ||
        l.date.includes(term)
      );
    })
    .sort(SORTS[sort]);
  const visibleUncleared = visible.filter((l) => !isCleared(l));
  const visibleCleared = visible.filter(isCleared);
  const allVisibleCleared = visible.length > 0 && visibleUncleared.length === 0;

  const setLines = (lines: ReconciliationLineDto[], cleared: boolean) => toggles.set(lines.map((l) => [l.journalLineId, cleared] as const));

  const onTick = (l: ReconciliationLineDto, shift: boolean) => {
    const want = !isCleared(l);
    const from = shift && anchor.current ? visible.findIndex((x) => x.journalLineId === anchor.current) : -1;
    const to = visible.findIndex((x) => x.journalLineId === l.journalLineId);
    if (from >= 0 && to >= 0) {
      setLines(visible.slice(Math.min(from, to), Math.max(from, to) + 1), want);
    } else {
      setLines([l], want);
    }
    anchor.current = l.journalLineId;
  };

  const onComplete = async () => {
    const ok = await confirm({
      title: 'Complete this reconciliation?',
      description: (
        <>
          The ticked transactions add up to the statement closing balance of {formatMoney(r.statementClosingBalance, cur)}. They are locked until the
          reconciliation is reopened.
        </>
      ),
      confirmLabel: 'Complete',
    });
    if (!ok) return;
    await toggles.flush();
    // A batch may have saved while the prompt was open; send the version it left behind.
    const version = qc.getQueryData<ReconciliationDetailDto>(qk.banking.reconciliation(company.id, id))?.version ?? r.version;
    complete.mutate(
      { version, idempotencyKey: idem.current },
      {
        onSuccess: () => {
          idem.current = idempotencyKey();
          toast.success('Reconciliation completed');
        },
        onError: (err) => onError(err, 'Could not complete reconciliation'),
      },
    );
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: 'Delete this reconciliation?',
      description: `The reconciliation for ${formatDate(r.statementStartDate)} – ${formatDate(r.statementEndDate)} and its ticks are removed. Your transactions are not changed.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    del.mutate(r.id, {
      onSuccess: () => {
        toast.success('Reconciliation deleted');
        router.push(listHref);
      },
      onError: (err) => onError(err, 'Could not delete reconciliation'),
    });
  };

  const submitReopen = () => {
    if (!reason.trim()) return;
    reopen.mutate(
      { version: r.version, reason: reason.trim() },
      {
        onSuccess: () => {
          toast.success('Reconciliation reopened');
          setReopening(false);
          setReason('');
        },
        onError: (err) => onError(err, 'Could not reopen reconciliation'),
      },
    );
  };

  const addMissingHref = `/journal/new?${new URLSearchParams({ date: r.statementEndDate, ...(ledgerAccountId ? { accountId: ledgerAccountId } : {}) }).toString()}`;

  return (
    <>
      <BackLink listPath="/banking/reconcile" label="Reconciliations" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {r.bankAccountName ?? 'Reconciliation'}
            <ReconciliationStatusBadge status={r.status} />
          </span>
        }
        description={
          <>
            Statement {formatDate(r.statementStartDate)} – {formatDate(r.statementEndDate)}
            {r.notes && <span className="block text-stone-500">“{r.notes}”</span>}
          </>
        }
        actions={
          <>
            {editable && (
              <Button variant="secondary" onClick={onDelete} loading={del.isPending}>
                Delete
              </Button>
            )}
            {!editable && (
              <Button variant="secondary" onClick={() => setReopening(true)}>
                Reopen…
              </Button>
            )}
          </>
        }
      />

      {r.status === 'flagged' && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <p className="font-semibold">This reconciliation needs another look</p>
          <p className="mt-0.5">{r.flaggedReason ?? 'No reason was recorded.'}</p>
          <p className="mt-1 text-xs text-red-700">A transaction it included has changed since it was completed. Reopen it to check the ticks again.</p>
        </div>
      )}
      {r.status === 'completed' && (
        <div role="status" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Completed {formatDateTime(r.completedAt)}
          {r.completedBy ? ` by ${r.completedBy}` : ''}. The ticked transactions are locked; reopen to make changes.
        </div>
      )}

      <Card className="mb-4">
        <dl className="grid gap-4 p-4 sm:grid-cols-3">
          <Stat label="Statement opening" value={formatMoney(r.statementOpeningBalance, cur)} testId="stat-opening" />
          <Stat label="Statement closing" value={formatMoney(r.statementClosingBalance, cur)} testId="stat-closing" />
          <Stat label="In Evenbooks at end" value={formatMoney(r.ledgerBalanceAtEnd, cur)} testId="stat-ledger" hint={`Everything recorded up to the statement end${isCard ? ', as an amount owed' : ''}`} />
        </dl>
      </Card>

      {/* Stays in view while ticking down a long statement. */}
      <div
        className="sticky top-0 z-20 mb-4 rounded-lg border border-stone-200 bg-white/95 px-4 py-3 shadow-sm backdrop-blur print:static"
        role="region"
        aria-label="Reconciliation totals"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Difference</p>
            <p data-testid="stat-difference" className={cn('text-xl font-semibold tabular-nums', balanced ? 'text-emerald-700' : 'text-red-700')} aria-live="polite">
              {formatMoney(difference, cur)}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Ticked balance</p>
            <p data-testid="stat-cleared" className="text-base font-semibold tabular-nums text-stone-900">
              {formatMoney(clearedBalance, cur)}
            </p>
            <p className="text-xs text-stone-500" data-testid="cleared-count">
              {clearedLines.length} of {r.lines.length} on statement
            </p>
          </div>
          <div className="text-sm">
            <p className="text-stone-600">
              <span className="font-medium text-stone-800">{sides.up}</span> {ups.length} ·{' '}
              <span className={cn('tabular-nums', !isCard && 'text-emerald-700')} data-testid="subtotal-deposits">
                {formatMoney(sumDecimals(ups.map((l) => l.amount)), cur)}
              </span>
            </p>
            <p className="text-stone-600">
              <span className="font-medium text-stone-800">{sides.down}</span> {downs.length} ·{' '}
              <span className={cn('tabular-nums', isCard && 'text-emerald-700')} data-testid="subtotal-withdrawals">
                {formatMoney(sumDecimals(downs.map((l) => l.amount)), cur)}
              </span>
            </p>
          </div>
          {editable && (
            <div className="ml-auto flex items-center gap-3">
              <span className="inline-flex items-center gap-1 text-xs text-stone-500" role="status" data-testid="save-state">
                {saving ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
                  </>
                ) : (
                  <>
                    <Check className="size-3.5" aria-hidden /> Saved
                  </>
                )}
              </span>
              <Button disabled={!balanced || saving} loading={complete.isPending} onClick={() => void onComplete()}>
                Complete reconciliation
              </Button>
            </div>
          )}
        </div>
        {editable && (
          <p className="mt-2 text-sm text-stone-600" data-testid="difference-help">
            {balanced ? (
              'Everything on the statement is accounted for. Complete the reconciliation to lock these ticks.'
            ) : (
              <>
                <span className="font-medium text-stone-800">Still to explain: {formatMoney(difference.replace(/^-/, ''), cur)}.</span> Look for a line on your statement that isn’t here (Add
                missing transaction), or one here that isn’t on your statement.
              </>
            )}
          </p>
        )}
      </div>

      <Card>
        <CardHeader
          title="Statement lines"
          description="Everything recorded in Evenbooks for this account up to the statement end. Tick each one that is on your statement; Shift-click ticks a range."
          actions={
            <>
              <Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as ShowFilter)} className="w-40">
                <option value="all">Show all</option>
                <option value="uncleared">Show not ticked</option>
                <option value="cleared">Show ticked</option>
              </Select>
              <Select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as SortOrder)} className="w-44">
                <option value="date">Date, oldest first</option>
                <option value="date_desc">Date, newest first</option>
                <option value="amount_desc">Amount, largest first</option>
                <option value="amount_asc">Amount, smallest first</option>
              </Select>
              <Input type="search" aria-label="Search lines" placeholder="Search memo, #, amount…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
              {editable && (
                <>
                  <Button variant="secondary" size="sm" className="whitespace-nowrap" disabled={visibleUncleared.length === 0} onClick={() => setLines(visibleUncleared, true)}>
                    Mark all as on statement
                  </Button>
                  <Button variant="secondary" size="sm" className="whitespace-nowrap" disabled={visibleCleared.length === 0} onClick={() => setLines(visibleCleared, false)}>
                    Unmark all
                  </Button>
                  <LinkButton href={addMissingHref} variant="secondary" size="sm" className="whitespace-nowrap">
                    <Plus className="size-4" aria-hidden /> Add missing transaction
                  </LinkButton>
                </>
              )}
            </>
          }
        />
        {r.lines.length === 0 && <EmptyState title="No transactions yet" description="Nothing is recorded for this account on or before the statement end date." />}
        {r.lines.length > 0 && visible.length === 0 && <EmptyState title="No lines match" />}
        {visible.length > 0 && (
          <Table aria-label="Statement lines">
            <THead>
              <TR>
                <TH className="w-10">
                  {editable ? (
                    <HeaderCheckbox
                      checked={allVisibleCleared}
                      indeterminate={!allVisibleCleared && visibleCleared.length > 0}
                      onChange={() => (allVisibleCleared ? setLines(visibleCleared, false) : setLines(visibleUncleared, true))}
                    />
                  ) : (
                    <span className="sr-only">On statement</span>
                  )}
                </TH>
                <TH className="w-28">Date</TH>
                <TH className="w-20">Entry #</TH>
                <TH>Memo</TH>
                <TH className="hidden md:table-cell">Source</TH>
                <TH numeric>Amount</TH>
              </TR>
            </THead>
            <TBody>
              {visible.map((l) => {
                const checked = isCleared(l);
                // Green for money coming your way: a deposit, or a payment or credit on a card.
                const favorable = compareDecimals(l.amount, '0') * (isCard ? -1 : 1) > 0;
                const hint = matchHint(l, checked);
                return (
                  <TR key={l.journalLineId} className={cn(hint ? 'bg-amber-50' : checked && 'bg-emerald-50/40')} data-match={hint ? 'true' : undefined}>
                    <TD>
                      <input
                        type="checkbox"
                        aria-label={`On statement: ${lineLabel(l)}`}
                        checked={checked}
                        disabled={!editable}
                        onChange={(e) => onTick(l, (e.nativeEvent as MouseEvent).shiftKey === true)}
                        className="size-4 rounded border-stone-300 text-brand-600 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-60"
                      />
                    </TD>
                    <TD>{formatDate(l.date)}</TD>
                    <TD className="font-mono text-xs">
                      <Link href={`/journal/${l.entryId}`} className="text-brand-700 hover:underline">
                        {l.entryNumber ?? '—'}
                      </Link>
                    </TD>
                    <TD>
                      <Link href={`/journal/${l.entryId}`} className="font-medium text-stone-800 hover:underline">
                        {l.memo || '(no memo)'}
                      </Link>
                      <p className="text-xs text-stone-500 md:hidden">{capitalize(l.sourceType)}</p>
                      {hint && <p className="mt-0.5 text-xs font-medium text-amber-800">{hint}</p>}
                    </TD>
                    <TD className="hidden md:table-cell">
                      <Badge tone={l.sourceType === 'manual' ? 'neutral' : 'blue'}>{capitalize(l.sourceType)}</Badge>
                    </TD>
                    <TD numeric className={cn(favorable && 'text-emerald-700')}>
                      {formatMoney(l.amount, cur)}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        )}
      </Card>

      <Dialog
        open={reopening}
        onClose={() => setReopening(false)}
        title="Reopen reconciliation"
        description="The ticks can be changed again. The reason is kept in the history."
        onSubmit={submitReopen}
        dirty={!!reason.trim() && !reopen.isPending}
        footer={
          <>
            <Button variant="secondary" onClick={() => setReopening(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!reason.trim()} loading={reopen.isPending}>
              Reopen
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="reopen-reason" required>
          <Textarea id="reopen-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
    </>
  );
}

function HeaderCheckbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange(): void }) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Mark all visible lines as on statement"
      checked={checked}
      onChange={onChange}
      className="size-4 rounded border-stone-300 text-brand-600 focus:ring-brand-500"
    />
  );
}

function Stat({ label, value, hint, testId, className }: { label: string; value: string; hint?: string; testId: string; className?: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">{label}</dt>
      <dd data-testid={testId} className={cn('mt-1 text-lg font-semibold tabular-nums text-stone-900', className)}>
        {value}
      </dd>
      {hint && <p className="text-xs text-stone-500">{hint}</p>}
    </div>
  );
}
