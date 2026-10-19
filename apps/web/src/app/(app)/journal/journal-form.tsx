'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Scale, Trash2 } from 'lucide-react';
import type { JournalEntryDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { DateInput } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { AccountPicker } from '@/components/account-picker';
import { useToast } from '@/components/ui/toast';
import { useCreateJournal, useUpdateDraftJournal } from '@/lib/queries/journal';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatMoney, isZeroDecimal, todayIso } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { compareDecimals, isValidDecimal, subtractDecimals, sumDecimals } from '@/lib/decimal';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useModKeyLabel, useSubmitShortcut } from '@/lib/use-hotkeys';

interface LineState {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
}

let keySeq = 1;
const blankLine = (patch: Partial<LineState> = {}): LineState => ({ key: keySeq++, accountId: '', debit: '', credit: '', memo: '', ...patch });

function linesFrom(entry: JournalEntryDto): LineState[] {
  return entry.lines.map((l) => ({
    key: keySeq++,
    accountId: l.accountId,
    debit: Number(l.debit) > 0 ? l.debit : '',
    credit: Number(l.credit) > 0 ? l.credit : '',
    memo: l.memo ?? '',
  }));
}

/** DOM id for a line's field; by position so server and client render the same ids. */
const lineField = (index: number, part: 'account' | 'debit' | 'credit') => `jl-${index}-${part}`;

/**
 * Manual journal form. Local state holds unsaved edits; the server is the only
 * source of truth after submit. Posting sends an idempotency key and disables
 * duplicate submission while pending. `copyOf` starts a new entry from an
 * existing one (Duplicate), dated today.
 */
export function JournalForm({ existing, copyOf, preset }: { existing?: JournalEntryDto; copyOf?: JournalEntryDto; preset?: { date?: string; accountId?: string } }) {
  const { company } = useCompany();
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const create = useCreateJournal();
  const update = useUpdateDraftJournal(existing?.id ?? '');
  const source = existing ?? copyOf;

  const initial = React.useMemo(
    () => ({
      date: existing?.date ?? preset?.date ?? todayIso(company.timeZone),
      memo: source?.memo ?? '',
      cashTreatment: (source?.cashTreatment === 'exclude' ? 'exclude' : 'include') as 'include' | 'exclude',
      lines: source ? linesFrom(source) : [blankLine({ accountId: preset?.accountId ?? '' }), blankLine()],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [date, setDate] = React.useState(initial.date);
  const [memo, setMemo] = React.useState(initial.memo);
  const [cashTreatment, setCashTreatment] = React.useState(initial.cashTreatment);
  const [lines, setLines] = React.useState<LineState[]>(initial.lines);
  const [errors, setErrors] = React.useState<FormError[]>([]);
  const idemRef = React.useRef(idempotencyKey());

  const snapshot = (s: { date: string; memo: string; cashTreatment: string; lines: LineState[] }) =>
    JSON.stringify([s.date, s.memo, s.cashTreatment, s.lines.map((l) => [l.accountId, l.debit, l.credit, l.memo])]);
  const [baseline, setBaseline] = React.useState(() => snapshot(initial));
  const dirty = snapshot({ date, memo, cashTreatment, lines }) !== baseline;
  const guard = useUnsavedChanges(dirty);

  const totalDebit = sumDecimals(lines.map((l) => (isValidDecimal(l.debit) ? l.debit : '0')));
  const totalCredit = sumDecimals(lines.map((l) => (isValidDecimal(l.credit) ? l.credit : '0')));
  const difference = subtractDecimals(totalDebit, totalCredit);
  const balanced = isZeroDecimal(difference);
  const cur = company.baseCurrency;
  const invalid = invalidFields(errors);

  const setLine = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  /** The amount (and side) that would balance the entry. */
  const balancingAmount = (): Partial<LineState> => {
    if (balanced) return {};
    const debitHeavy = compareDecimals(difference, '0') > 0;
    const amount = debitHeavy ? difference : subtractDecimals('0', difference);
    return debitHeavy ? { credit: amount, debit: '' } : { debit: amount, credit: '' };
  };

  const addLine = () => setLines((ls) => [...ls, blankLine(balancingAmount())]);

  /** Put the difference on the last line without amounts, or on a new line. */
  const balance = () => {
    const patch = balancingAmount();
    const target = [...lines].reverse().find((l) => !l.debit.trim() && !l.credit.trim());
    if (target) setLine(target.key, patch);
    else setLines((ls) => [...ls, blankLine(patch)]);
  };

  const validate = (): FormError[] => {
    const errs: FormError[] = [];
    if (!date) errs.push({ message: 'Date is required.', fieldId: 'je-date' });
    const used = lines.filter((l) => l.accountId || l.debit || l.credit);
    if (used.length < 2) errs.push({ message: 'At least two lines are required.' });
    used.forEach((l, i) => {
      const at = lines.indexOf(l);
      if (!l.accountId) errs.push({ message: `Line ${i + 1}: choose an account.`, fieldId: lineField(at, 'account') });
      const d = l.debit.trim();
      const c = l.credit.trim();
      if (d && !isValidDecimal(d)) errs.push({ message: `Line ${i + 1}: the debit is not a number.`, fieldId: lineField(at, 'debit') });
      if (c && !isValidDecimal(c)) errs.push({ message: `Line ${i + 1}: the credit is not a number.`, fieldId: lineField(at, 'credit') });
      if ((d && Number(d) > 0) === (c && Number(c) > 0)) errs.push({ message: `Line ${i + 1}: enter either a debit or a credit.`, fieldId: lineField(at, 'debit') });
    });
    if (!balanced) errs.push({ message: `Debits (${formatMoney(totalDebit, cur)}) must equal credits (${formatMoney(totalCredit, cur)}). Use Balance to fill the difference.` });
    return errs;
  };

  const payloadLines = () =>
    lines
      .filter((l) => l.accountId || l.debit || l.credit)
      .map((l) => ({
        accountId: l.accountId,
        debit: l.debit.trim() && Number(l.debit) > 0 ? l.debit.trim() : undefined,
        credit: l.credit.trim() && Number(l.credit) > 0 ? l.credit.trim() : undefined,
        memo: l.memo || null,
      }));

  const resetForNext = () => {
    // Keep the date and cash treatment: a batch of entries usually shares them.
    const next = { date, memo: '', cashTreatment, lines: [blankLine(), blankLine()] };
    setMemo('');
    setLines(next.lines);
    setErrors([]);
    setBaseline(snapshot(next));
    idemRef.current = idempotencyKey();
    requestAnimationFrame(() => document.getElementById(lineField(0, 'account'))?.focus());
  };

  const submit = (post: boolean, andNew = false) => {
    const errs = validate();
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    if (existing) {
      update.mutate(
        { version: existing.version, date, memo, cashTreatment, lines: payloadLines() },
        {
          onSuccess: (e) => {
            guard.markSaved();
            toast.success('Draft saved');
            router.push(`/journal/${e.id}`);
          },
          onError: (e) => onError(e, 'Could not save draft'),
        },
      );
      return;
    }
    create.mutate(
      { date, memo, cashTreatment, lines: payloadLines(), post, idempotencyKey: idemRef.current },
      {
        onSuccess: (e) => {
          const title = post ? `Posted entry #${e.entryNumber}` : 'Draft saved';
          if (andNew) {
            toast.success(title, undefined, { action: { label: 'View', onClick: () => router.push(`/journal/${e.id}`) } });
            resetForNext();
            return;
          }
          guard.markSaved();
          toast.success(title);
          router.push(`/journal/${e.id}`);
        },
        onError: (e) => {
          onError(e, post ? 'Posting failed' : 'Could not save draft');
        },
      },
    );
  };

  const pending = create.isPending || update.isPending;
  const modKey = useModKeyLabel();
  const shortcut = useSubmitShortcut(() => !pending && submit(!existing), true);

  return (
    <>
      <PageHeader
        title={existing ? 'Edit draft entry' : copyOf ? `New entry (copy of #${copyOf.entryNumber ?? 'draft'})` : 'New journal entry'}
        description={
          <>
            Most people never need this. To record money in or out, use{' '}
            <Link href="/banking/inbox" className="text-brand-700 underline-offset-2 hover:underline">
              Bank transactions
            </Link>
            ,{' '}
            <Link href="/purchases/new" className="text-brand-700 underline-offset-2 hover:underline">
              Record expense
            </Link>{' '}
            or{' '}
            <Link href="/payments/new" className="text-brand-700 underline-offset-2 hover:underline">
              Record payment received
            </Link>
            . What customers owe you, their credits and sales tax change only through invoices, payments and credit notes, so those accounts can’t be used here.
          </>
        }
      />
      <Card>
        <CardBody className="space-y-5">
          <div {...shortcut} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Date" htmlFor="je-date" required>
                <DateInput id="je-date" aria-label="Date" value={date} onChange={setDate} aria-invalid={invalid.has('je-date') || undefined} />
              </Field>
              <Field
                label="Count on cash-basis reports?"
                htmlFor="cash"
                required
                hint={
                  cashTreatment === 'include'
                    ? 'Income and expense lines show on cash-basis reports on this date. Choose this when money actually moved.'
                    : 'Only accrual reports include it, for example a year-end adjustment where no money moved.'
                }
              >
                <Select id="cash" value={cashTreatment} onChange={(e) => setCashTreatment(e.target.value as 'include' | 'exclude')}>
                  <option value="include">Yes</option>
                  <option value="exclude">No (accrual adjustment)</option>
                </Select>
              </Field>
            </div>
            <Field label="Memo" htmlFor="memo">
              <Textarea id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
            </Field>

            <div>
              <div className="mb-2 hidden grid-cols-12 gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500 sm:grid">
                <div className="col-span-5">Account</div>
                <div className="col-span-2 text-right">Debit</div>
                <div className="col-span-2 text-right">Credit</div>
                <div className="col-span-2">Line memo</div>
                <div className="col-span-1" />
              </div>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={l.key} className="grid grid-cols-12 items-center gap-2 rounded-md border border-stone-200 p-2 sm:border-0 sm:p-0">
                    <div className="col-span-12 sm:col-span-5">
                      <AccountPicker
                        id={lineField(i, 'account')}
                        aria-label={`Line ${i + 1} account`}
                        value={l.accountId}
                        recentKey="journal-line-account"
                        invalid={invalid.has(lineField(i, 'account'))}
                        onChange={(v) => setLine(l.key, { accountId: v ?? '' })}
                      />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <MoneyInput
                        id={lineField(i, 'debit')}
                        aria-label={`Line ${i + 1} debit`}
                        placeholder="Debit"
                        value={l.debit}
                        aria-invalid={invalid.has(lineField(i, 'debit')) || undefined}
                        onChange={(v) => setLine(l.key, { debit: v, credit: v ? '' : l.credit })}
                      />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <MoneyInput
                        id={lineField(i, 'credit')}
                        aria-label={`Line ${i + 1} credit`}
                        placeholder="Credit"
                        value={l.credit}
                        aria-invalid={invalid.has(lineField(i, 'credit')) || undefined}
                        onChange={(v) => setLine(l.key, { credit: v, debit: v ? '' : l.debit })}
                        onKeyDown={(e) => {
                          // Enter on the last line's credit adds a line, like a spreadsheet.
                          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && i === lines.length - 1) {
                            e.preventDefault();
                            addLine();
                          }
                        }}
                      />
                    </div>
                    <div className="col-span-3 sm:col-span-2">
                      <Input aria-label={`Line ${i + 1} memo`} placeholder="Memo" value={l.memo} onChange={(e) => setLine(l.key, { memo: e.target.value })} />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button variant="ghost" size="sm" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} disabled={lines.length <= 2}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={addLine}>
                    <Plus className="size-4" /> Add line
                  </Button>
                  {!balanced && (
                    <Button variant="secondary" size="sm" onClick={balance}>
                      <Scale className="size-4" /> Balance
                    </Button>
                  )}
                </div>
                <p className={`tabular text-sm ${balanced ? 'text-stone-600' : 'text-red-700'}`} aria-live="polite">
                  Debits {formatMoney(totalDebit, cur)} · Credits {formatMoney(totalCredit, cur)}
                  {!balanced && ` · Difference ${formatMoney(difference.replace(/^-/, ''), cur)}`}
                </p>
              </div>
            </div>
          </div>

          <ErrorSummary errors={errors} />

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4">
            <span className="mr-auto hidden text-xs text-stone-500 sm:inline">
              {modKey}+Enter to {existing ? 'save' : 'post'}
            </span>
            <Button variant="secondary" onClick={() => void guard.leave(() => router.back())} disabled={pending}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => submit(false)} loading={pending}>
              {existing ? 'Save draft' : 'Save as draft'}
            </Button>
            {!existing && (
              <>
                <Button variant="secondary" onClick={() => submit(true, true)} loading={pending} disabled={!balanced}>
                  Post and new
                </Button>
                <Button onClick={() => submit(true)} loading={pending} disabled={!balanced}>
                  Post entry
                </Button>
              </>
            )}
          </div>
        </CardBody>
      </Card>
    </>
  );
}
