'use client';
import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import type { AccountDto, AttachmentDto, BankTransactionDto, InvoiceCandidateDto, MatchCandidateDto } from '@evenbooks/contracts';
import { isTransferAccount } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, ErrorNotice, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/input';
import { useDeleteRecordAction } from '@/components/delete-record-dialog';
import { Dialog } from '@/components/ui/dialog';
import { MoneyInput } from '@/components/ui/money-input';
import { useToast } from '@/components/ui/toast';
import { AccountPicker } from '@/components/account-picker';
import { ContactPicker } from '@/components/contact-picker';
import { HelpTip, Term } from '@/components/ui/term';
import { useAccounts } from '@/lib/queries/accounts';
import {
  useBankAccountsForInbox,
  useCategorizeTransaction,
  useExcludeTransaction,
  useInbox,
  useInvoiceCandidates,
  useMatchCandidates,
  useMatchTransaction,
  useRecordInvoicePayment,
  useTransferTransaction,
} from '@/lib/queries/inbox';
import { uploadAttachment } from '@/lib/queries/purchases';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import { compareDecimals, isValidDecimal, subtractDecimals, sumDecimals } from '@/lib/decimal';
import { useCompany } from '@/components/company-context';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';
import { cleanRulePattern, descriptionMatches } from './rule-pattern';
import { absDecimal, hasStrongMatch, isMoneyIn, preferFor, ReasonChips, useInboxActions } from './shared';

export type Mode = 'categorize' | 'transfer' | 'match' | 'exclude';
export interface ReviewTarget {
  txn: BankTransactionDto;
  /** Open on this tab (for example Exclude from the "e" shortcut); otherwise Match when a strong candidate exists, else Categorize. */
  mode?: Mode;
}
export type ReviewDone = (result: BankTransactionDto, next: boolean, alsoReviewed?: string[]) => void;

type SubmitFn = (next: boolean) => void;
interface FormProps {
  txn: BankTransactionDto;
  submitRef: React.RefObject<SubmitFn | null>;
  onDone: ReviewDone;
  onPending: (pending: boolean) => void;
}
/** Categorize can send the reader to Match, with an unpaid invoice already chosen. */
type SwitchToMatch = (invoiceId?: string) => void;

const MODES: { value: Mode; label: string }[] = [
  { value: 'categorize', label: 'Categorize' },
  { value: 'transfer', label: 'Transfer' },
  { value: 'match', label: 'Match' },
  { value: 'exclude', label: 'Exclude' },
];
const ACTION_LABEL: Record<Mode, string> = { categorize: 'Categorize', transfer: 'Record transfer', match: 'Match', exclude: 'Exclude' };
/** Each tab in one line, shown under the tabs (and in full behind the "?"). */
const MODE_HELP: Record<Mode, string> = {
  categorize: 'Say what it was for: an expense, income, or personal spending.',
  transfer: 'Money moved between two of your own accounts.',
  match: 'It’s already in your books, or it pays an invoice.',
  exclude: 'It isn’t real: a duplicate, or a charge the bank reversed.',
};

const initialMode = (t: ReviewTarget): Mode => t.mode ?? (hasStrongMatch(t.txn) ? 'match' : 'categorize');

/**
 * Review one bank line. "Save & next" (also Enter in a field) records the
 * decision and opens the next unreviewed line without closing the dialog; the
 * plain action button records it and closes.
 */
export function ReviewDialog({ target, hasNext, onClose, onDone }: { target: ReviewTarget | null; hasNext: boolean; onClose: () => void; onDone: ReviewDone }) {
  const txn = target?.txn ?? null;
  // Mode follows the target: a new line (or a re-open) starts on its own initial tab.
  const [modeState, setModeState] = React.useState<{ target: ReviewTarget | null; mode: Mode }>({ target: null, mode: 'categorize' });
  const mode: Mode = target && modeState.target !== target ? initialMode(target) : modeState.mode;
  const setMode = (m: Mode) => setModeState({ target, mode: m });
  // An invoice chosen from Categorize's "looks like payment for INV-…" switch, for Match to start with.
  const [invoicePick, setInvoicePick] = React.useState<{ txnId: string; invoiceId: string } | null>(null);
  const switchToMatch: SwitchToMatch = (invoiceId) => {
    setInvoicePick(invoiceId && txn ? { txnId: txn.id, invoiceId } : null);
    setMode('match');
  };
  // Match relabels the footer button when it records a payment rather than a match.
  const [matchLabel, setMatchLabel] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const submitRef = React.useRef<SubmitFn | null>(null);
  const nextRef = React.useRef(false);
  const bodyRef = React.useRef<HTMLDivElement>(null);

  // Put the cursor in the first field whenever a new line (or tab) shows; the
  // Dialog only does this when it first opens.
  const txnId = txn?.id;
  React.useEffect(() => {
    if (!txnId) return;
    const id = requestAnimationFrame(() => {
      bodyRef.current?.querySelector<HTMLElement>('[data-first-field] input:not([disabled]), [data-first-field] textarea')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [txnId, mode]);

  // Rendered beside the dialog, not inside it: its form must not nest in this one.
  const del = useDeleteRecordAction('bank_transaction', txn?.id ?? '', { onDeleted: onClose });

  const hint = txn?.matchHint;
  return (
    <>
      {del.dialog}
      <Dialog
        open={Boolean(txn)}
        onClose={onClose}
        size="lg"
        title={txn ? `Review: ${txn.description}` : 'Review transaction'}
        description={txn ? <HeaderDetails txn={txn} /> : undefined}
        onSubmit={() => {
          const next = nextRef.current;
          nextRef.current = false;
          submitRef.current?.(next);
        }}
        footer={
          txn ? (
            <>
              {/* Deleting an imported line (a duplicate, a bad import) is deliberate, so it lives here, not on the row. */}
              {del.item && (
                <Button variant="ghost" className="mr-auto" onClick={del.item.onSelect}>
                  <Trash2 className="size-4" aria-hidden /> Delete…
                </Button>
              )}
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              {/* First submit button in the form, so Enter in a field means "save and go on". */}
              {hasNext && (
                <Button type="submit" variant="secondary" loading={pending} onClick={() => (nextRef.current = true)}>
                  Save &amp; next
                </Button>
              )}
              <Button type="submit" variant={mode === 'exclude' ? 'danger' : 'primary'} loading={pending} onClick={() => (nextRef.current = false)}>
                {mode === 'match' && matchLabel ? matchLabel : ACTION_LABEL[mode]}
              </Button>
            </>
          ) : undefined
        }
      >
        {txn && (
          <div className="space-y-4" ref={bodyRef}>
            <div role="tablist" aria-label="Review action" className="flex flex-wrap gap-1 rounded-md bg-stone-100 p-1">
              {MODES.map((m) => {
                const n = m.value === 'match' ? (hint?.count ?? 0) + (hint?.invoices ?? 0) : m.value === 'transfer' ? (hint?.transfers ?? 0) : 0;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="tab"
                    aria-selected={mode === m.value}
                    onClick={() => setMode(m.value)}
                    className={cn(
                      'inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors',
                      mode === m.value ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600 hover:text-stone-900',
                    )}
                  >
                    {m.label}
                    {n > 0 && (
                      <span className="rounded-full bg-sky-100 px-1.5 text-xs text-sky-800">
                        {n}
                        <span className="sr-only">{m.value === 'match' ? ' likely matches' : ' possible other sides'}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1 text-sm text-stone-600">
              {MODE_HELP[mode]}
              <HelpTip id={mode} />
            </div>
            {mode === 'categorize' && <CategorizeForm key={txn.id} txn={txn} submitRef={submitRef} onDone={onDone} onPending={setPending} onSwitchToMatch={switchToMatch} />}
            {mode === 'transfer' && <TransferForm key={txn.id} txn={txn} submitRef={submitRef} onDone={onDone} onPending={setPending} />}
            {mode === 'match' && (
              <MatchForm
                key={txn.id}
                txn={txn}
                submitRef={submitRef}
                onDone={onDone}
                onPending={setPending}
                initialInvoiceId={invoicePick?.txnId === txn.id ? invoicePick.invoiceId : undefined}
                onActionLabel={setMatchLabel}
              />
            )}
            {mode === 'exclude' && <ExcludeForm key={txn.id} txn={txn} submitRef={submitRef} onDone={onDone} onPending={setPending} />}
            {hasNext && <p className="text-xs text-stone-500">Enter saves and opens the next transaction.</p>}
          </div>
        )}
      </Dialog>
    </>
  );
}

/** Dialog subtitle: date, account, amount, then the bank's payee, memo and reference. Inline content only (it renders inside a <p>). */
function HeaderDetails({ txn }: { txn: BankTransactionDto }) {
  const extra = [txn.payee && `Payee: ${txn.payee}`, txn.memo && `Memo: ${txn.memo}`, txn.reference && `Ref: ${txn.reference}`].filter(Boolean);
  return (
    <>
      {formatDate(txn.date)} · {txn.bankAccountName ?? ''} · {formatMoney(txn.amount, txn.currency)}
      {txn.pending && (
        <Badge tone="amber" className="ml-2">
          Pending
        </Badge>
      )}
      {extra.length > 0 && <span className="mt-0.5 block text-stone-600">{extra.join(' · ')}</span>}
    </>
  );
}

/** Forms report their mutation state upward so the footer submit button can show loading. */
function useReportPending(onPending: (p: boolean) => void, pending: boolean) {
  React.useEffect(() => {
    onPending(pending);
  }, [onPending, pending]);
}

/** Hands the form's submit function to the dialog footer. */
function useSubmitHandle(submitRef: React.RefObject<SubmitFn | null>, submit: SubmitFn) {
  React.useImperativeHandle(submitRef, () => submit);
}

function FormError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      {error}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Categorize
// ---------------------------------------------------------------------------
interface SplitLine {
  key: number;
  accountId: string;
  amount: string;
  description: string;
}
type MatchType = 'contains' | 'starts_with' | 'equals';
type Direction = 'any' | 'in' | 'out';

interface UploadState {
  key: number;
  file: File;
  status: 'uploading' | 'done' | 'error';
  attachment?: AttachmentDto;
  error?: string;
}

/**
 * Receipts chosen in the Categorize form upload right away (like Record
 * expense); their ids travel with the categorization, which links them to the
 * expense or entry it records.
 */
function useReceiptUploads() {
  const { company } = useCompany();
  const [uploads, setUploads] = React.useState<UploadState[]>([]);
  const seq = React.useRef(1);
  const setUpload = (key: number, patch: Partial<UploadState>) => setUploads((us) => us.map((u) => (u.key === key ? { ...u, ...patch } : u)));
  const add = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const key = seq.current++;
      setUploads((us) => [...us, { key, file, status: 'uploading' }]);
      uploadAttachment(company.id, file, 'receipt')
        .then((attachment) => setUpload(key, { status: 'done', attachment }))
        .catch((e: unknown) => setUpload(key, { status: 'error', error: e instanceof Error ? e.message : 'Upload failed' }));
    }
  };
  const remove = (key: number) => setUploads((us) => us.filter((u) => u.key !== key));
  const ids = uploads.flatMap((u) => (u.status === 'done' && u.attachment ? [u.attachment.id] : []));
  return { uploads, add, remove, ids, uploading: uploads.some((u) => u.status === 'uploading'), failed: uploads.some((u) => u.status === 'error') };
}

function ReceiptField({ receipts }: { receipts: ReturnType<typeof useReceiptUploads> }) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div>
      <Field label="Receipt" htmlFor="cat-receipts" hint="Optional. A photo or PDF, up to 15 MB. It’s kept with this transaction.">
        <Input
          id="cat-receipts"
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/*"
          className="h-auto py-1.5"
          onChange={(e) => {
            receipts.add(e.target.files);
            if (inputRef.current) inputRef.current.value = '';
          }}
        />
      </Field>
      {receipts.uploads.length > 0 && (
        <ul className="mt-2 divide-y divide-stone-100 rounded-md border border-stone-200 text-sm" aria-label="Receipt uploads" aria-busy={receipts.uploading}>
          {receipts.uploads.map((u) => (
            <li key={u.key} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                {u.status === 'uploading' && <Loader2 className="size-4 shrink-0 animate-spin text-stone-500" aria-hidden />}
                {u.status === 'done' && <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />}
                {u.status === 'error' && <XCircle className="size-4 shrink-0 text-red-600" aria-hidden />}
                <span className="truncate">{u.file.name}</span>
                <span className="shrink-0 text-xs text-stone-500">{u.status === 'uploading' ? 'Uploading…' : u.status === 'done' ? 'Uploaded' : (u.error ?? 'Failed')}</span>
              </span>
              <Button variant="ghost" size="sm" aria-label={`Remove ${u.file.name}`} disabled={u.status === 'uploading'} onClick={() => receipts.remove(u.key)}>
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One-tap answers for the common cases a category list hides. */
function QuickChoice({ pressed, onClick, children, help }: { pressed: boolean; onClick: () => void; children: React.ReactNode; help?: 'owner-draw' | 'owner-contribution' }) {
  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        aria-pressed={pressed}
        onClick={onClick}
        className={cn(
          'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
          pressed ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-50',
        )}
      >
        {children}
      </button>
      {help && <HelpTip id={help} />}
    </span>
  );
}

function CategorizeForm({ txn, submitRef, onDone, onPending, onSwitchToMatch }: FormProps & { onSwitchToMatch: SwitchToMatch }) {
  const { company } = useCompany();
  const cur = company.baseCurrency;
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { undoOne } = useInboxActions();
  const categorize = useCategorizeTransaction();
  useReportPending(onPending, categorize.isPending);
  const idemRef = React.useRef(idempotencyKey());
  const lineSeq = React.useRef(1);
  const moneyIn = isMoneyIn(txn.amount);
  const total = absDecimal(txn.amount);
  const prefer = React.useMemo(() => preferFor(moneyIn), [moneyIn]);
  const recentKey = moneyIn ? 'inbox-categorize-in' : 'inbox-categorize-out';
  const accounts = useAccounts();
  const byId = React.useMemo(() => new Map((accounts.data ?? []).map((a) => [a.id, a])), [accounts.data]);
  const ownerAccount = (accounts.data ?? []).find((a) => a.isActive && a.role === (moneyIn ? 'owner_equity' : 'owner_draws'));
  const invoices = useInvoiceCandidates(txn.id, null, { enabled: moneyIn });
  const receipts = useReceiptUploads();

  const [accountId, setAccountId] = React.useState(txn.suggestion?.accountId ?? '');
  const [contactId, setContactId] = React.useState<string | null>(txn.suggestion?.contactId ?? null);
  const [memo, setMemo] = React.useState(txn.suggestion?.memo ?? '');
  const [split, setSplit] = React.useState(false);
  const [lines, setLines] = React.useState<SplitLine[]>([]);
  const [createRule, setCreateRule] = React.useState(false);
  const [pattern, setPattern] = React.useState(() => cleanRulePattern(txn.description));
  const [matchType, setMatchType] = React.useState<MatchType>('contains');
  const [direction, setDirection] = React.useState<Direction>(moneyIn ? 'in' : 'out');
  const [error, setError] = React.useState<string | null>(null);

  const splitTotal = sumDecimals(lines.map((l) => l.amount));
  const remaining = subtractDecimals(total, splitTotal);
  const newLine = (acct = ''): SplitLine => ({ key: lineSeq.current++, accountId: acct, amount: '', description: '' });

  // Income chosen for a deposit that an unpaid invoice is waiting for: recording it as income
  // would count the sale twice and leave the invoice unpaid.
  const sameAmountInvoice = (invoices.data ?? []).find((c) => c.reason === 'exact');
  const chosenIds = split ? lines.map((l) => l.accountId) : [accountId];
  const incomeChosen = chosenIds.some((id) => byId.get(id)?.type === 'income');

  const toggleSplit = (on: boolean) => {
    setSplit(on);
    setLines(on ? [newLine(accountId), newLine()] : []);
  };
  const setLine = (key: number, patch: Partial<SplitLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = (next: boolean) => {
    setError(null);
    let payloadLines: { accountId: string; amount: string; description: string }[];
    if (split) {
      const used = lines.filter((l) => l.accountId || l.amount);
      if (used.length < 2) return setError('Add at least two split lines, or turn off Split.');
      for (const l of used) {
        if (!l.accountId) return setError('Every split line needs a category.');
        if (!isValidDecimal(l.amount) || compareDecimals(l.amount, '0') <= 0) return setError('Every split line needs a positive amount.');
      }
      if (compareDecimals(remaining, '0') !== 0) return setError(`Split lines must add up to ${formatMoney(total, cur)} (remaining ${formatMoney(remaining, cur)}).`);
      payloadLines = used.map((l) => ({ accountId: l.accountId, amount: l.amount.trim(), description: l.description }));
    } else {
      if (!accountId) return setError('Choose a category.');
      payloadLines = [{ accountId, amount: total, description: '' }];
    }
    if (receipts.uploading) return setError('Wait for the receipt to finish uploading.');
    if (receipts.failed) return setError('Remove the receipt that failed to upload, or try it again.');
    const rule = createRule && !split;
    if (rule && !pattern.trim()) return setError('Enter a pattern for the rule.');
    categorize.mutate(
      {
        id: txn.id,
        input: {
          version: txn.version,
          contactId: contactId || null,
          memo: memo || null,
          lines: payloadLines,
          createRule: rule ? { pattern: pattern.trim(), matchType, direction } : undefined,
          attachmentIds: receipts.ids.length ? receipts.ids : undefined,
          idempotencyKey: idemRef.current,
        },
      },
      {
        onSuccess: (res) => {
          toast.success('Transaction categorized', rule ? 'A rule was saved for similar transactions.' : undefined, { action: { label: 'Undo', onClick: () => undoOne(res) } });
          onDone(res, next);
        },
        onError: (e) => onError(e, 'Could not categorize'),
      },
    );
  };
  useSubmitHandle(submitRef, submit);

  return (
    <div aria-busy={categorize.isPending} className="space-y-4">
      <p className="text-sm text-stone-600">
        {moneyIn ? 'Money in' : 'Money out'} · {formatMoney(total, cur)}
      </p>

      {!split && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Common choices">
          {moneyIn && (
            <QuickChoice pressed={false} onClick={() => onSwitchToMatch()}>
              Customer paid an invoice
            </QuickChoice>
          )}
          {ownerAccount && (
            <QuickChoice pressed={accountId === ownerAccount.id} onClick={() => setAccountId(ownerAccount.id)} help={moneyIn ? 'owner-contribution' : 'owner-draw'}>
              {moneyIn ? 'Money I put in (owner contribution)' : 'Personal spending (owner draw)'}
            </QuickChoice>
          )}
        </div>
      )}

      {!split ? (
        <div data-first-field>
          <Field label="Category" htmlFor="cat-account" required hint={txn.suggestion ? `Suggested by rule “${txn.suggestion.ruleName}”` : undefined}>
            <AccountPicker
              id="cat-account"
              value={accountId}
              onChange={(id) => setAccountId(id ?? '')}
              prefer={prefer}
              preferLabel={moneyIn ? 'Income' : 'Expenses'}
              recentKey={recentKey}
              createType={moneyIn ? 'income' : 'expense'}
              placeholder="Search categories…"
              invalid={error === 'Choose a category.'}
            />
          </Field>
        </div>
      ) : (
        <div>
          <div className="mb-2 hidden grid-cols-12 gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500 sm:grid">
            <div className="col-span-6">Category</div>
            <div className="col-span-3 text-right">Amount</div>
            <div className="col-span-2">Note</div>
            <div className="col-span-1" />
          </div>
          <div className="space-y-2">
            {lines.map((l, i) => (
              <div key={l.key} className="grid grid-cols-12 items-center gap-2" data-first-field={i === 0 ? true : undefined}>
                <div className="col-span-12 sm:col-span-6">
                  <AccountPicker
                    aria-label={`Split ${i + 1} category`}
                    value={l.accountId}
                    onChange={(id) => setLine(l.key, { accountId: id ?? '' })}
                    prefer={prefer}
                    preferLabel={moneyIn ? 'Income' : 'Expenses'}
                    recentKey={recentKey}
                    createType={moneyIn ? 'income' : 'expense'}
                    placeholder="Search categories…"
                  />
                </div>
                <div className="col-span-5 sm:col-span-3">
                  <MoneyInput aria-label={`Split ${i + 1} amount`} value={l.amount} onChange={(v) => setLine(l.key, { amount: v })} />
                </div>
                <div className="col-span-5 sm:col-span-2">
                  <Input aria-label={`Split ${i + 1} note`} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                </div>
                <div className="col-span-2 flex justify-end sm:col-span-1">
                  <Button variant="ghost" size="sm" aria-label={`Remove split ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} disabled={lines.length <= 2}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus className="size-4" /> Add line
              </Button>
              {compareDecimals(remaining, '0') > 0 && lines.some((l) => !l.amount) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const empty = lines.find((l) => !l.amount);
                    if (empty) setLine(empty.key, { amount: remaining });
                  }}
                >
                  Fill remaining
                </Button>
              )}
            </div>
            <p className={cn('tabular text-sm', compareDecimals(remaining, '0') === 0 ? 'text-stone-600' : 'text-red-700')} aria-live="polite">
              Allocated {formatMoney(splitTotal, cur)} · Remaining {formatMoney(remaining, cur)}
            </p>
          </div>
        </div>
      )}
      {moneyIn && incomeChosen && sameAmountInvoice && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>
            This looks like payment for {sameAmountInvoice.number} from {sameAmountInvoice.contactName}. Record it as an invoice payment instead?
          </p>
          <Button size="sm" variant="secondary" onClick={() => onSwitchToMatch(sameAmountInvoice.invoiceId)}>
            Record invoice payment
          </Button>
        </div>
      )}
      <Checkbox label="Split" checked={split} onChange={(e) => toggleSplit(e.target.checked)} />

      <div className="grid gap-4 sm:grid-cols-2">
        <ContactPicker label="Customer or vendor" id="cat-contact" value={contactId} onChange={(id) => setContactId(id)} clearable placeholder="None" />
        <Field label="Note" htmlFor="cat-memo">
          <Input id="cat-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </Field>
      </div>

      <ReceiptField receipts={receipts} />

      <div className="space-y-3 rounded-md border border-stone-200 bg-stone-50 p-3">
        <Checkbox label="Create a rule for future transactions like this" checked={createRule && !split} onChange={(e) => setCreateRule(e.target.checked)} disabled={split} />
        {createRule && !split && (
          <>
            <div className="grid gap-3 sm:grid-cols-6">
              <Field label="Description" htmlFor="rule-match" className="sm:col-span-2">
                <Select id="rule-match" value={matchType} onChange={(e) => setMatchType(e.target.value as MatchType)}>
                  <option value="contains">contains</option>
                  <option value="starts_with">starts with</option>
                  <option value="equals">equals</option>
                </Select>
              </Field>
              <Field label="Pattern" htmlFor="rule-pattern" className="sm:col-span-4" required hint="Store numbers, dates and card digits are left out so the next visit matches too.">
                <Input id="rule-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} />
              </Field>
              <Field label="Applies to" htmlFor="rule-direction" className="sm:col-span-3">
                <Select id="rule-direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                  <option value="out">Money out</option>
                  <option value="in">Money in</option>
                  <option value="any">Money in or out</option>
                </Select>
              </Field>
            </div>
            <RulePreview txn={txn} pattern={pattern} matchType={matchType} direction={direction} />
          </>
        )}
        {split && <p className="text-xs text-stone-500">Rules suggest a single category, so they cannot be created from a split.</p>}
      </div>

      <FormError error={error} />
    </div>
  );
}

/** "Matches 4 other transactions in the inbox", checked against the unreviewed lines the search returns. */
function RulePreview({ txn, pattern, matchType, direction }: { txn: BankTransactionDto; pattern: string; matchType: MatchType; direction: Direction }) {
  const debounced = useDebounced(pattern.trim(), 400);
  const q = useInbox({ status: 'unreviewed', q: debounced || undefined, limit: 200 }, { enabled: debounced.length >= 2 });
  if (debounced.length < 2 || !q.data) return null;
  const others = q.data.items.filter(
    (t) =>
      t.id !== txn.id &&
      descriptionMatches(t.description, debounced, matchType) &&
      (direction === 'any' || (direction === 'in') === isMoneyIn(t.amount)),
  ).length;
  const more = q.data.nextCursor ? '+' : '';
  return (
    <p className="text-xs text-stone-600" aria-live="polite">
      {others === 0 ? 'No other transaction in the inbox matches yet.' : `Matches ${others}${more} other ${others === 1 && !more ? 'transaction' : 'transactions'} in the inbox.`}{' '}
      {others > 0 && (
        <Link href={`/banking/inbox?q=${encodeURIComponent(debounced)}`} className="font-medium text-brand-700 hover:underline" target="_blank">
          Show them
        </Link>
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------
function TransferForm({ txn, submitRef, onDone, onPending }: FormProps) {
  const { company } = useCompany();
  const cur = company.baseCurrency;
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { undoOne } = useInboxActions();
  const transfer = useTransferTransaction();
  useReportPending(onPending, transfer.isPending);
  const candidates = useMatchCandidates(txn.id);
  const bankAccounts = useBankAccountsForInbox();
  const idemRef = React.useRef(idempotencyKey());
  const ownLedgerId = bankAccounts.data?.find((b) => b.id === txn.bankAccountId)?.ledgerAccountId;
  const allow = React.useCallback((a: AccountDto) => a.id !== ownLedgerId && isTransferAccount(a), [ownLedgerId]);

  const counterparts = (candidates.data ?? []).filter((c) => c.targetType === 'bank_transaction');
  const [choice, setChoice] = React.useState<string>('other');
  const [otherId, setOtherId] = React.useState('');
  const [memo, setMemo] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (counterparts.length > 0 && choice === 'other' && !otherId) setChoice(counterparts[0]!.targetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [counterparts.length]);

  const submit = (next: boolean) => {
    setError(null);
    const useCounterpart = choice !== 'other';
    if (!useCounterpart && !otherId) return setError('Choose the other account.');
    transfer.mutate(
      {
        id: txn.id,
        input: {
          version: txn.version,
          counterpartTransactionId: useCounterpart ? choice : undefined,
          otherLedgerAccountId: useCounterpart ? undefined : otherId,
          memo: memo || null,
          idempotencyKey: idemRef.current,
        },
      },
      {
        onSuccess: (res) => {
          toast.success('Transfer recorded', undefined, { action: { label: 'Undo', onClick: () => undoOne(res) } });
          onDone(res, next, useCounterpart ? [choice] : undefined);
        },
        onError: (e) => onError(e, 'Could not record transfer'),
      },
    );
  };
  useSubmitHandle(submitRef, submit);

  return (
    <div aria-busy={transfer.isPending} className="space-y-4">
      <p className="text-sm text-stone-600">
        {isMoneyIn(txn.amount) ? 'Money came in from' : 'Money went out to'} another of your accounts. A transfer isn’t income or spending.
      </p>
      {candidates.isPending && <Spinner label="Looking for the other side…" />}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-stone-700">Other side</legend>
        {counterparts.map((c) => (
          <label key={c.targetId} className="flex cursor-pointer items-start gap-3 rounded-md border border-stone-200 p-3 text-sm hover:bg-stone-50">
            <input type="radio" name="transfer-choice" className="mt-0.5" checked={choice === c.targetId} onChange={() => setChoice(c.targetId)} />
            <span className="flex-1">
              <span className="font-medium">{c.bankAccountName ?? 'Bank transaction'}</span>
              <span className="block text-xs text-stone-500">
                {formatDate(c.date)} · {c.description}
              </span>
            </span>
            <span className="tabular">{formatMoney(c.amount, cur)}</span>
          </label>
        ))}
        <div className="space-y-2 rounded-md border border-stone-200 p-3 text-sm">
          <label className="flex cursor-pointer items-start gap-3">
            <input type="radio" name="transfer-choice" className="mt-0.5" checked={choice === 'other'} onChange={() => setChoice('other')} />
            <span className="flex-1">
              <span className="font-medium">One of my other accounts (card, loan, owner)</span>
              <span className="block text-xs text-stone-500">For example a credit card payment, a loan payment, or a payout from Stripe or PayPal, when the other side isn’t imported here.</span>
            </span>
          </label>
          <div className="ml-7 sm:max-w-sm" data-first-field={counterparts.length === 0 ? true : undefined}>
            <AccountPicker
              aria-label="Other account"
              value={otherId}
              onChange={(id) => {
                setOtherId(id ?? '');
                if (id) setChoice('other');
              }}
              allow={allow}
              recentKey="inbox-transfer"
              createType="liability"
              invalid={error === 'Choose the other account.'}
            />
          </div>
        </div>
      </fieldset>
      <Field label="Note" htmlFor="transfer-memo">
        <Input id="transfer-memo" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </Field>
      <FormError error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------
const isFeeAccount = (a: AccountDto) => a.role === 'bank_fees' || a.type === 'expense';

/** Up to this many payments waiting to be deposited are searched for a group that adds up to the deposit. */
const GROUP_SEARCH_LIMIT = 12;

/** The first group of candidates whose amounts add up exactly to `amount`, if any. */
function groupAddingUpTo(list: MatchCandidateDto[], amount: string): MatchCandidateDto[] | null {
  const pool = list.slice(0, GROUP_SEARCH_LIMIT);
  for (let mask = 1; mask < 1 << pool.length; mask++) {
    const pick = pool.filter((_, i) => mask & (1 << i));
    if (pick.length > 1 && compareDecimals(sumDecimals(pick.map((c) => c.amount)), amount) === 0) return pick;
  }
  return null;
}

/** How a deposit pays the chosen invoices, oldest due first, like the server does. */
function invoicePlan(invoices: InvoiceCandidateDto[], deposit: string) {
  let left = deposit;
  const parts = [...invoices]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number))
    .map((inv) => {
      const part = compareDecimals(inv.balanceDue, left) <= 0 ? inv.balanceDue : left;
      left = subtractDecimals(left, part);
      return { inv, part, full: compareDecimals(part, inv.balanceDue) === 0 };
    });
  return { parts, credit: left };
}

const invoiceLabel = (c: InvoiceCandidateDto, cur: string) =>
  `Unpaid invoice ${c.number} · ${c.contactName} · ${formatMoney(c.balanceDue, cur)} · due ${formatDate(c.dueDate)}`;

function MatchForm({ txn, submitRef, onDone, onPending, initialInvoiceId, onActionLabel }: FormProps & { initialInvoiceId?: string; onActionLabel: (label: string | null) => void }) {
  const { company } = useCompany();
  const cur = company.baseCurrency;
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { undoOne } = useInboxActions();
  const match = useMatchTransaction();
  const pay = useRecordInvoicePayment();
  useReportPending(onPending, match.isPending || pay.isPending);
  const moneyIn = isMoneyIn(txn.amount);
  const candidates = useMatchCandidates(txn.id);
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const invoices = useInvoiceCandidates(txn.id, customerId, { enabled: moneyIn });
  const accounts = useAccounts();
  const idemRef = React.useRef(idempotencyKey());
  const payIdemRef = React.useRef(idempotencyKey());
  const list = (candidates.data ?? []).filter((c) => c.targetType !== 'bank_transaction');

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [picked, setPicked] = React.useState<Set<string>>(() => new Set(initialInvoiceId ? [initialInvoiceId] : []));
  const [feeAmount, setFeeAmount] = React.useState('');
  const [feeAccountId, setFeeAccountId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  // Invoices stay known after the customer filter changes, so a chosen one keeps its label.
  const [seen, setSeen] = React.useState<Map<string, InvoiceCandidateDto>>(new Map());
  React.useEffect(() => {
    if (!invoices.data?.length) return;
    setSeen((prev) => {
      const next = new Map(prev);
      invoices.data.forEach((c) => next.set(c.invoiceId, c));
      return next;
    });
  }, [invoices.data]);
  const invoiceList = invoices.data ?? [];
  const pickedInvoices = [...picked].flatMap((id) => {
    const c = seen.get(id) ?? invoiceList.find((x) => x.invoiceId === id);
    return c ? [c] : [];
  });
  const paying = picked.size > 0;

  const defaultFee = (accounts.data ?? []).find((a) => a.role === 'bank_fees' && a.isActive)?.id;
  React.useEffect(() => {
    if (!feeAccountId && defaultFee) setFeeAccountId(defaultFee);
  }, [defaultFee, feeAccountId]);

  const keyOf = (c: MatchCandidateDto) => `${c.targetType}:${c.targetId}`;
  // Start with the obvious answer ticked: one same-amount record close to the date, else a group
  // of payments waiting to be deposited that adds up to the deposit, else the one unpaid
  // invoice for exactly this amount.
  const autoPicked = React.useRef(Boolean(initialInvoiceId));
  React.useEffect(() => {
    if (autoPicked.current || !candidates.data || (moneyIn && !invoices.data)) return;
    autoPicked.current = true;
    const exact = list.filter((c) => compareDecimals(c.amount, txn.amount) === 0);
    if (exact.length === 1 && exact[0]!.score >= 90) return setSelected(new Set([keyOf(exact[0]!)]));
    if (exact.length > 0) return;
    const group = groupAddingUpTo(list.filter((c) => c.undeposited), txn.amount);
    if (group) return setSelected(new Set(group.map(keyOf)));
    const sameAmount = (invoices.data ?? []).filter((c) => c.reason === 'exact');
    if (sameAmount.length === 1) setPicked(new Set([sameAmount[0]!.invoiceId]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates.data, invoices.data]);

  const chosen = list.filter((c) => selected.has(keyOf(c)));
  const total = sumDecimals(chosen.map((c) => c.amount));
  const differs = chosen.length > 0 && compareDecimals(total, txn.amount) !== 0;
  const fee = feeAmount.trim() && isValidDecimal(feeAmount) ? feeAmount.trim() : '0';
  const net = subtractDecimals(total, fee);
  const balanced = chosen.length > 0 && compareDecimals(net, txn.amount) === 0;
  const plan = invoicePlan(pickedInvoices, txn.amount);
  const customers = new Set(pickedInvoices.map((c) => c.contactId));

  const actionLabel = paying ? 'Record payment' : null;
  React.useEffect(() => {
    onActionLabel(actionLabel);
  }, [actionLabel, onActionLabel]);
  React.useEffect(() => () => onActionLabel(null), [onActionLabel]);

  // A deposit is either an invoice payment or a match to records; choosing one clears the other.
  const toggle = (c: MatchCandidateDto) => {
    setPicked(new Set());
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(c);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const toggleInvoice = (c: InvoiceCandidateDto) => {
    setSelected(new Set());
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(c.invoiceId)) next.delete(c.invoiceId);
      else next.add(c.invoiceId);
      return next;
    });
  };

  const submitPayment = (next: boolean) => {
    if (customers.size > 1) return setError('One deposit can pay invoices from one customer. Choose invoices from the same customer.');
    const unused = plan.parts.find((p) => compareDecimals(p.part, '0') <= 0);
    if (unused) return setError(`This deposit is used up before ${unused.inv.number}. Leave that invoice out.`);
    pay.mutate(
      { id: txn.id, input: { version: txn.version, invoiceIds: pickedInvoices.map((c) => c.invoiceId), idempotencyKey: payIdemRef.current } },
      {
        onSuccess: (res) => {
          const numbers = plan.parts.map((p) => p.inv.number).join(', ');
          const credit = compareDecimals(plan.credit, '0') > 0 ? `${formatMoney(plan.credit, cur)} extra is kept as credit for ${pickedInvoices[0]!.contactName}.` : undefined;
          toast.success(`Payment recorded for ${numbers}`, credit);
          onDone(res, next);
        },
        onError: (e) => onError(e, 'Could not record the payment'),
      },
    );
  };

  const submit = (next: boolean) => {
    setError(null);
    if (paying) return submitPayment(next);
    if (chosen.length === 0) return setError(moneyIn ? 'Choose the invoice this pays, or a record to match.' : 'Select at least one record to match.');
    const hasFee = compareDecimals(fee, '0') > 0;
    if (hasFee && !feeAccountId) return setError('Choose a category for the fee.');
    if (chosen.some((c) => c.undeposited) && chosen.some((c) => !c.undeposited)) {
      return setError('Payments waiting to be deposited can’t be matched together with other records. Match them on their own.');
    }
    if (!balanced) return setError(`Selected records (${formatMoney(total, cur)}) minus fee (${formatMoney(fee, cur)}) must equal ${formatMoney(txn.amount, cur)}.`);
    match.mutate(
      {
        id: txn.id,
        input: {
          version: txn.version,
          targets: chosen.map((c) => ({ targetType: c.targetType as Exclude<MatchCandidateDto['targetType'], 'bank_transaction'>, targetId: c.targetId })),
          fee: hasFee ? { amount: fee, accountId: feeAccountId } : undefined,
          idempotencyKey: idemRef.current,
        },
      },
      {
        onSuccess: (res) => {
          toast.success('Transaction matched', undefined, { action: { label: 'Undo', onClick: () => undoOne(res) } });
          onDone(res, next);
        },
        onError: (e) => onError(e, 'Could not match'),
      },
    );
  };
  useSubmitHandle(submitRef, submit);

  const loading = candidates.isPending || (moneyIn && invoices.isPending);
  const nothingAtAll = !loading && list.length === 0 && (!moneyIn || (invoiceList.length === 0 && !customerId));

  return (
    <div aria-busy={match.isPending || pay.isPending} className="space-y-4">
      {moneyIn && (
        <section aria-labelledby="pay-invoice-heading" className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 id="pay-invoice-heading" className="text-sm font-medium text-stone-800">
              Customer paid an invoice
            </h3>
            <div className="w-full sm:w-64">
              <ContactPicker kind="customer" label="Customer" id="pay-customer" value={customerId} onChange={(id) => setCustomerId(id)} clearable placeholder="Any customer" />
            </div>
          </div>
          {invoices.isError && <ErrorNotice error={invoices.error} onRetry={() => invoices.refetch()} />}
          {invoices.data && invoiceList.length === 0 && (
            <EmptyState compact title={customerId ? 'No unpaid invoices for this customer' : 'No unpaid invoice with a similar amount'} description={customerId ? undefined : 'Pick the customer to see all of their unpaid invoices.'} />
          )}
          {invoiceList.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="sr-only">Unpaid invoices</legend>
              {invoiceList.map((c) => (
                <label key={c.invoiceId} className="flex cursor-pointer items-start gap-3 rounded-md border border-stone-200 p-3 text-sm hover:bg-stone-50">
                  <input type="checkbox" className="mt-0.5 size-4 rounded border-stone-300" checked={picked.has(c.invoiceId)} onChange={() => toggleInvoice(c)} />
                  <span className="flex-1">
                    <span className="font-medium">{invoiceLabel(c, cur)}</span>
                    <span className="block text-xs text-stone-500">
                      {c.reason === 'exact' ? 'Same amount as this deposit' : c.reason === 'customer' ? 'From this customer' : 'Similar amount'}
                      {c.isOverdue ? ' · Overdue' : ''}
                      {compareDecimals(c.balanceDue, c.total) !== 0 ? ` · ${formatMoney(c.total, cur)} invoice, part paid` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {paying && (
            <p className="rounded-md bg-stone-50 p-3 text-sm text-stone-700" aria-live="polite">
              {'This deposit '}
              {plan.parts.map((p, i) => (
                <React.Fragment key={p.inv.invoiceId}>
                  {i > 0 && (i === plan.parts.length - 1 ? ' and ' : ', ')}
                  {p.full ? `pays ${p.inv.number} in full` : compareDecimals(p.part, '0') > 0 ? `pays ${formatMoney(p.part, cur)} of ${p.inv.number} (${formatMoney(subtractDecimals(p.inv.balanceDue, p.part), cur)} still owed)` : `leaves nothing for ${p.inv.number}`}
                </React.Fragment>
              ))}
              {'.'}
              {compareDecimals(plan.credit, '0') > 0 && ` ${formatMoney(plan.credit, cur)} extra is kept as credit for ${pickedInvoices[0]?.contactName}.`}
              {' '}Saving records the payment and matches this bank line to it.
            </p>
          )}
        </section>
      )}

      <section aria-labelledby="recorded-heading" className="space-y-2">
        <h3 id="recorded-heading" className="text-sm font-medium text-stone-800">
          {moneyIn ? 'Or: already recorded' : 'Already recorded'}
        </h3>
        <p className="text-sm text-stone-600">Link this bank line to something already in your books, so it isn’t counted twice.</p>
        {loading && <Spinner label="Finding matches…" />}
        {candidates.isError && <ErrorNotice error={candidates.error} onRetry={() => candidates.refetch()} />}
        {candidates.data && list.length === 0 && !nothingAtAll && (
          <EmptyState compact title="Nothing recorded with this amount" description={moneyIn ? 'If a customer paid an invoice, choose it above.' : undefined} />
        )}
        {nothingAtAll && (
          <EmptyState
            title="No matching records"
            description={
              moneyIn
                ? 'Nothing recorded near this date with this amount. If a customer paid you, pick them under Customer to see their unpaid invoices. Otherwise categorize it.'
                : 'Nothing recorded near this date with this amount. Categorize it instead, or record the expense first.'
            }
          />
        )}
        {list.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="sr-only">Recorded transactions</legend>
            {list.map((c) => (
              <label key={keyOf(c)} className="flex cursor-pointer items-start gap-3 rounded-md border border-stone-200 p-3 text-sm hover:bg-stone-50">
                <input type="checkbox" className="mt-0.5 size-4 rounded border-stone-300" checked={selected.has(keyOf(c))} onChange={() => toggle(c)} />
                <span className="flex-1">
                  <span className="font-medium">{c.description}</span>
                  <span className="block text-xs text-stone-500">
                    {formatDate(c.date)}
                    {c.detail ? ` · ${c.detail}` : ''}
                  </span>
                </span>
                <span className="tabular">{formatMoney(c.amount, cur)}</span>
              </label>
            ))}
          </fieldset>
        )}
        {list.length > 0 && !paying && (
          <div className="space-y-3 rounded-md border border-stone-200 bg-stone-50 p-3">
            <p className={cn('tabular text-sm', balanced || chosen.length === 0 ? 'text-stone-700' : 'text-red-700')} aria-live="polite">
              Selected {formatMoney(total, cur)}
              {compareDecimals(fee, '0') > 0 && ` − fee ${formatMoney(fee, cur)} = ${formatMoney(net, cur)}`} · Transaction {formatMoney(txn.amount, cur)}
              {chosen.length > 0 && !balanced && ' · Does not add up yet'}
            </p>
            {(differs || compareDecimals(fee, '0') > 0) && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Fee amount" htmlFor="fee-amount" hint="A bank or card processing fee that explains why less arrived.">
                  <MoneyInput id="fee-amount" value={feeAmount} onChange={setFeeAmount} placeholder="0.00" />
                </Field>
                <Field label="Fee category" htmlFor="fee-account">
                  <AccountPicker id="fee-account" value={feeAccountId} onChange={(id) => setFeeAccountId(id ?? '')} allow={isFeeAccount} recentKey="inbox-fee" createType="expense" />
                </Field>
              </div>
            )}
          </div>
        )}
      </section>
      <FormError error={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exclude
// ---------------------------------------------------------------------------
function ExcludeForm({ txn, submitRef, onDone, onPending }: FormProps) {
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const { undoOne } = useInboxActions();
  const exclude = useExcludeTransaction();
  useReportPending(onPending, exclude.isPending);
  const [reason, setReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const submit = (next: boolean) => {
    setError(null);
    if (!reason.trim()) return setError('A reason is required.');
    exclude.mutate(
      { id: txn.id, input: { version: txn.version, reason: reason.trim() } },
      {
        onSuccess: (res) => {
          toast.success('Transaction excluded', undefined, { action: { label: 'Undo', onClick: () => undoOne(res) } });
          onDone(res, next);
        },
        onError: (e) => onError(e, 'Could not exclude'),
      },
    );
  };
  useSubmitHandle(submitRef, submit);
  return (
    <div aria-busy={exclude.isPending} className="space-y-4">
      <div className="text-sm text-stone-600">
        Only for lines that aren’t real: duplicates, or a charge the bank reversed. Personal spending still left your account; record it as{' '}
        <Term id="owner-draw">Personal spending</Term> on the Categorize tab instead.
      </div>
      <ReasonChips value={reason} onPick={setReason} />
      <div data-first-field>
        <Field label="Reason" htmlFor="exclude-reason" required error={error}>
          <Textarea id="exclude-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
      </div>
    </div>
  );
}
