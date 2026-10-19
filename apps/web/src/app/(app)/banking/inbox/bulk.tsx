'use client';
import * as React from 'react';
import { ArrowLeftRight, CheckCheck, Tags, X, XCircle } from 'lucide-react';
import { isTransferAccount, type AccountDto, type BankTransactionDto, type BulkReviewInput, type BulkReviewResultDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/dialog';
import { ErrorNotice } from '@/components/ui/card';
import { useToast } from '@/components/ui/toast';
import { AccountPicker } from '@/components/account-picker';
import { useBankAccountsForInbox, useBulkReview } from '@/lib/queries/inbox';
import { useCompany } from '@/components/company-context';
import { sumDecimals } from '@/lib/decimal';
import { formatDate, formatMoney } from '@/lib/format';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { absDecimal, isMoneyIn, needsMatch, preferFor, ReasonChips, useInboxActions } from './shared';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const skippedNote = (n: number) => (n > 0 ? `${n} skipped: already recorded` : undefined);

/**
 * Runs one bulk action and reports it: a success toast with Undo for the lines
 * that went through, an error toast naming the first failure otherwise.
 * Accepting suggestions skips lines that look already recorded (`skipped` the
 * caller left out, plus any the server refused as duplicates) and says so.
 * `onSettled` receives the ids that succeeded so the caller can drop them from the selection.
 */
function useRunBulk(onSettled: (succeeded: string[]) => void) {
  const bulk = useBulkReview();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { undoMany } = useInboxActions();
  const run = (input: BulkReviewInput, verb: string, after?: (result: BulkReviewResultDto) => void, skippedByCaller = 0) => {
    bulk.mutate(input, {
      onSuccess: (res: BulkReviewResultDto) => {
        const done = res.results.filter((r) => r.ok && r.transaction).map((r) => r.transaction!);
        const refused = input.action === 'accept_suggestion' ? res.results.filter((r) => !r.ok && r.error?.code === 'duplicate').length : 0;
        const skipped = skippedByCaller + refused;
        const failed = res.results.filter((r) => !r.ok).length - refused;
        if (done.length > 0) {
          toast.success(`${verb} ${plural(done.length, input.action === 'transfer' ? 'transfer' : 'transaction')}`, skippedNote(skipped), { action: { label: 'Undo', onClick: () => undoMany(done) } });
        } else if (skipped > 0 && failed === 0) {
          toast.success(`Nothing ${verb.toLowerCase()}`, `${skippedNote(skipped)}. Open each one and match it instead.`);
        }
        if (failed > 0) {
          const first = res.results.find((r) => !r.ok && !(input.action === 'accept_suggestion' && r.error?.code === 'duplicate'));
          toast.error(`${plural(failed, 'transaction')} could not be ${input.action === 'transfer' ? 'recorded as a transfer' : verb.toLowerCase()}`, first?.error?.message);
        }
        onSettled(done.map((t) => t.id));
        after?.(res);
      },
      onError: (e) => onError(e, `Could not update the selected transactions`),
    });
  };
  return { run, pending: bulk.isPending };
}

export function BulkBar({ selected, onClear, onSettled }: { selected: BankTransactionDto[]; onClear: () => void; onSettled: (succeeded: string[]) => void }) {
  // One idempotency key per action for the current selection: a retry after a
  // network error reuses it, a new selection or a finished action gets a fresh one.
  const keys = React.useRef<Record<string, string>>({});
  const keyFor = (action: string) => (keys.current[action] ??= idempotencyKey());
  const selectionKey = selected.map((t) => `${t.id}:${t.version}`).join(',');
  React.useEffect(() => {
    keys.current = {};
  }, [selectionKey]);
  const { run, pending } = useRunBulk((ids) => {
    keys.current = {};
    onSettled(ids);
  });
  const [dialog, setDialog] = React.useState<'categorize' | 'transfer' | 'exclude' | null>(null);
  // Lines that look already recorded need a match, not a second record.
  const withSuggestion = selected.filter((t) => t.suggestion && !needsMatch(t));
  const skipped = selected.filter((t) => t.suggestion && needsMatch(t)).length;
  const items = (list: BankTransactionDto[]) => list.map((t) => ({ id: t.id, version: t.version }));
  if (selected.length === 0) return null;
  return (
    <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 border-b border-brand-200 bg-brand-50 px-3 py-2 text-sm">
      <span className="font-medium text-stone-800">{selected.length} selected</span>
      <Button
        size="sm"
        loading={pending && !dialog}
        disabled={withSuggestion.length === 0}
        onClick={() => run({ action: 'accept_suggestion', items: items(withSuggestion), idempotencyKey: keyFor('accept') }, 'Categorized', undefined, skipped)}
      >
        <CheckCheck className="size-4" aria-hidden /> Accept {plural(withSuggestion.length, 'suggestion')}
      </Button>
      {skipped > 0 && <span className="text-xs text-stone-600">{skippedNote(skipped)}</span>}
      <Button size="sm" variant="secondary" onClick={() => setDialog('categorize')} disabled={pending}>
        <Tags className="size-4" aria-hidden /> Categorize to…
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setDialog('transfer')} disabled={pending}>
        <ArrowLeftRight className="size-4" aria-hidden /> Transfer…
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setDialog('exclude')} disabled={pending}>
        <XCircle className="size-4" aria-hidden /> Exclude…
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear} className="ml-auto">
        <X className="size-4" aria-hidden /> Clear selection
      </Button>
      <BulkCategorizeDialog
        open={dialog === 'categorize'}
        selected={selected}
        pending={pending}
        onClose={() => setDialog(null)}
        onSubmit={(accountId) =>
          run({ action: 'categorize', items: items(selected), accountId, idempotencyKey: keyFor(`categorize:${accountId}`) }, 'Categorized', () => setDialog(null))
        }
      />
      <BulkExcludeDialog
        open={dialog === 'exclude'}
        count={selected.length}
        pending={pending}
        onClose={() => setDialog(null)}
        onSubmit={(reason) => run({ action: 'exclude', items: items(selected), reason, idempotencyKey: keyFor(`exclude:${reason}`) }, 'Excluded', () => setDialog(null))}
      />
      {dialog === 'transfer' && (
        <BulkTransferDialog
          selected={selected}
          pending={pending}
          onClose={() => setDialog(null)}
          onSubmit={(otherLedgerAccountId) => run(
            { action: 'transfer', items: items(selected), otherLedgerAccountId, idempotencyKey: keyFor(`transfer:${otherLedgerAccountId}`) },
            'Recorded',
            (res) => { if (res.failed === 0) setDialog(null); },
          )}
        />
      )}
    </div>
  );
}

function BulkTransferDialog({ selected, pending, onClose, onSubmit }: {
  selected: BankTransactionDto[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (accountId: string) => void;
}) {
  const { company } = useCompany();
  const banks = useBankAccountsForInbox();
  const [accountId, setAccountId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const ownLedgerIds = React.useMemo(() => new Set(
    (banks.data ?? []).filter((b) => selected.some((t) => t.bankAccountId === b.id)).map((b) => b.ledgerAccountId),
  ), [banks.data, selected]);
  const allow = React.useCallback((a: AccountDto) => isTransferAccount(a) && !ownLedgerIds.has(a.id), [ownLedgerIds]);
  const banksReady = banks.isSuccess && selected.every((t) => banks.data.some((b) => b.id === t.bankAccountId));
  const incoming = selected.filter((t) => isMoneyIn(t.amount));
  const outgoing = selected.filter((t) => !isMoneyIn(t.amount));
  const label = outgoing.length === 0 ? 'Transfer from' : incoming.length === 0 ? 'Transfer to' : 'Other account';
  const cur = company.baseCurrency;
  return (
    <Dialog
      open
      onClose={() => { if (!pending) onClose(); }}
      title={`Record ${plural(selected.length, 'transfer')}`}
      description="Choose the other account for all selected transactions. Each one is recorded as a separate transfer; your income and expenses don’t change."
      onSubmit={() => {
        if (pending || !banksReady) return;
        if (!accountId || ownLedgerIds.has(accountId)) return setError('Choose a different account.');
        onSubmit(accountId);
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" loading={pending} disabled={!banksReady}>Record {plural(selected.length, 'transfer')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {banks.isError && <ErrorNotice error={banks.error} onRetry={() => banks.refetch()} />}
        <Field label={label} htmlFor="bulk-transfer-account" required error={error}>
          <AccountPicker
            id="bulk-transfer-account"
            value={accountId}
            onChange={(id) => { setAccountId(id ?? ''); setError(null); }}
            allow={allow}
            recentKey="inbox-transfer"
            createType={false}
            disabled={pending || !banksReady}
            invalid={!!error}
          />
        </Field>
        <div className="space-y-2 rounded-md bg-stone-50 p-3 text-sm" aria-label="Transfer totals">
          {incoming.length > 0 && <p>Money in from this account: <strong className="tabular">{formatMoney(sumDecimals(incoming.map((t) => t.amount)), cur)}</strong> · {plural(incoming.length, 'transaction')}</p>}
          {outgoing.length > 0 && <p>Money out to this account: <strong className="tabular">{formatMoney(sumDecimals(outgoing.map((t) => absDecimal(t.amount))), cur)}</strong> · {plural(outgoing.length, 'transaction')}</p>}
        </div>
        <ul aria-label="Selected transfers" className="max-h-56 divide-y divide-stone-200 overflow-y-auto text-sm">
          {selected.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="break-words font-medium">{t.description}</p>
                <p className="text-xs text-stone-500">{formatDate(t.date)} · {t.bankAccountName ?? banks.data?.find((b) => b.id === t.bankAccountId)?.name}</p>
              </div>
              <span className="tabular shrink-0">{formatMoney(t.amount, cur)}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-stone-600">Use this when the other side has not been imported. If both sides are imported, review each transfer individually to link them.</p>
      </div>
    </Dialog>
  );
}

function BulkCategorizeDialog({
  open,
  selected,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  selected: BankTransactionDto[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (accountId: string) => void;
}) {
  const [accountId, setAccountId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setAccountId('');
      setError(null);
    }
  }, [open]);
  const ins = selected.filter((t) => isMoneyIn(t.amount)).length;
  const direction = ins === selected.length ? 'in' : ins === 0 ? 'out' : 'mixed';
  const prefer = React.useMemo(() => (direction === 'mixed' ? undefined : preferFor(direction === 'in')), [direction]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Categorize ${plural(selected.length, 'transaction')}`}
      description={direction === 'mixed' ? 'The selection has money in and money out; each line is recorded in the category you pick.' : 'Each line is recorded in this category for its full amount.'}
      onSubmit={() => {
        if (!accountId) return setError('Choose a category.');
        onSubmit(accountId);
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Categorize {selected.length}
          </Button>
        </>
      }
    >
      <Field label="Category" htmlFor="bulk-account" required error={error}>
        <AccountPicker
          id="bulk-account"
          value={accountId}
          onChange={(id) => {
            setAccountId(id ?? '');
            setError(null);
          }}
          prefer={prefer}
          preferLabel={direction === 'in' ? 'Income' : 'Expenses'}
          recentKey={direction === 'in' ? 'inbox-categorize-in' : 'inbox-categorize-out'}
          placeholder="Search categories…"
          invalid={!!error}
        />
      </Field>
    </Dialog>
  );
}

function BulkExcludeDialog({ open, count, pending, onClose, onSubmit }: { open: boolean; count: number; pending: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Exclude ${plural(count, 'transaction')}`}
      description="Excluded lines stay listed here but are left out of your books. Only for lines that aren’t real, such as duplicates or a charge the bank reversed."
      onSubmit={() => {
        if (!reason.trim()) return setError('A reason is required.');
        onSubmit(reason.trim());
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={pending}>
            Exclude {count}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ReasonChips value={reason} onPick={setReason} />
        <Field label="Reason" htmlFor="bulk-exclude-reason" required error={error}>
          <Input id="bulk-exclude-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
