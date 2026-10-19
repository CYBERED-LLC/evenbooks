'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Info, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import type { AccountDto, AttachmentDto, PurchaseDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardBody, PageHeader } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { DateInput } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { AccountPicker } from '@/components/account-picker';
import { ContactPicker } from '@/components/contact-picker';
import { useToast } from '@/components/ui/toast';
import { useAccounts } from '@/lib/queries/accounts';
import { useCreatePurchase, useFetchLatestPurchase, uploadAttachment } from '@/lib/queries/purchases';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatMoney, todayIso } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { compareDecimals, isValidDecimal, sumDecimals } from '@/lib/decimal';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useModKeyLabel, useSubmitShortcut } from '@/lib/use-hotkeys';

interface LineState {
  key: number;
  accountId: string;
  description: string;
  amount: string;
}

interface UploadState {
  key: number;
  file: File;
  status: 'uploading' | 'done' | 'error';
  attachment?: AttachmentDto;
  error?: string;
}

let keySeq = 1;
const blankLine = (patch: Partial<LineState> = {}): LineState => ({ key: keySeq++, accountId: '', description: '', amount: '', ...patch });

/** Accounts a purchase can be paid from: bank accounts and credit cards. */
export const isPaymentAccount = (a: AccountDto) => a.role === 'bank' || a.role === 'credit_card';
/** Accounts a purchase line can use: expenses and non-bank assets. */
const isLineAccount = (a: AccountDto) => (a.type === 'expense' || a.type === 'asset') && !isPaymentAccount(a);
const isExpense = (a: AccountDto) => a.type === 'expense';

/** DOM id for a line's field; by position so server and client render the same ids. */
const lineField = (index: number, part: 'account' | 'amount') => `pl-${index}-${part}`;

const isPositive = (v: string) => isValidDecimal(v) && compareDecimals(v, '0') > 0;

/**
 * Expense (purchase) form. Receipts are uploaded as soon as they are chosen and
 * the resulting attachment ids travel with the purchase on submit. Saving
 * sends an idempotency key and blocks duplicate submission while pending.
 * `copyOf` starts a new purchase from an existing one (Duplicate), dated today.
 * Picking a vendor fills "Paid from" and the first line's account from their
 * last receipt, unless those were already chosen.
 */
export function PurchaseForm({ copyOf }: { copyOf?: PurchaseDto }) {
  const { company } = useCompany();
  const router = useRouter();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const accounts = useAccounts();
  const create = useCreatePurchase();
  const fetchLatest = useFetchLatestPurchase();

  const initial = React.useMemo(
    () => ({
      date: todayIso(company.timeZone),
      contactId: copyOf?.contactId ?? '',
      paidFromAccountId: copyOf?.paidFromAccountId ?? '',
      direction: copyOf?.direction ?? ('outflow' as 'outflow' | 'inflow'),
      reference: '',
      memo: copyOf?.memo ?? '',
      lines: copyOf?.lines.length ? copyOf.lines.map((l) => blankLine({ accountId: l.accountId, description: l.description, amount: l.amount })) : [blankLine()],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [date, setDate] = React.useState(initial.date);
  const [contactId, setContactId] = React.useState(initial.contactId);
  const [paidFromAccountId, setPaidFromAccountId] = React.useState(initial.paidFromAccountId);
  const [direction, setDirection] = React.useState(initial.direction);
  const [reference, setReference] = React.useState(initial.reference);
  const [memo, setMemo] = React.useState(initial.memo);
  const [lines, setLines] = React.useState<LineState[]>(initial.lines);
  const [uploads, setUploads] = React.useState<UploadState[]>([]);
  const [errors, setErrors] = React.useState<FormError[]>([]);
  const [defaultsNote, setDefaultsNote] = React.useState<string | null>(null);
  const idemRef = React.useRef(idempotencyKey());
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // "Paid from" chosen by the user (or copied), as opposed to filled in as a default.
  const paidFromChosen = React.useRef(!!copyOf);
  const vendorRequest = React.useRef(0);

  const cur = company.baseCurrency;
  const invalid = invalidFields(errors);
  const total = sumDecimals(lines.map((l) => (isValidDecimal(l.amount) ? l.amount : '0')));
  const all = React.useMemo(() => accounts.data ?? [], [accounts.data]);
  const paymentAccounts = React.useMemo(() => all.filter((a) => a.isActive && isPaymentAccount(a)), [all]);

  // Only one account can pay for it: preselect it.
  React.useEffect(() => {
    if (!paidFromAccountId && paymentAccounts.length === 1) setPaidFromAccountId(paymentAccounts[0]!.id);
  }, [paymentAccounts, paidFromAccountId]);

  const snapshot = (s: { date: string; contactId: string; paidFrom: string; direction: string; reference: string; memo: string; lines: LineState[]; uploads: number }) =>
    JSON.stringify([s.date, s.contactId, s.paidFrom, s.direction, s.reference, s.memo, s.lines.map((l) => [l.accountId, l.description, l.amount]), s.uploads]);
  const [baseline, setBaseline] = React.useState(() => snapshot({ ...initial, paidFrom: copyOf ? initial.paidFromAccountId : '', uploads: 0 }));
  const dirty =
    snapshot({ date, contactId, paidFrom: paidFromChosen.current ? paidFromAccountId : '', direction, reference, memo, lines, uploads: uploads.length }) !== baseline;
  const guard = useUnsavedChanges(dirty);

  const setLine = (key: number, patch: Partial<LineState>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const setUpload = (key: number, patch: Partial<UploadState>) => setUploads((us) => us.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  const addLine = () => {
    const index = lines.length;
    setLines((ls) => [...ls, blankLine()]);
    requestAnimationFrame(() => document.getElementById(lineField(index, 'account'))?.focus());
  };

  const onVendorChange = (id: string | null) => {
    setContactId(id ?? '');
    setDefaultsNote(null);
    if (!id) return;
    const request = ++vendorRequest.current;
    fetchLatest(id)
      .then((last) => {
        if (!last || request !== vendorRequest.current) return;
        const byId = new Map(all.map((a) => [a.id, a]));
        const paidFrom = byId.get(last.paidFromAccountId);
        let filled = false;
        if (!paidFromChosen.current && paidFrom?.isActive && isPaymentAccount(paidFrom)) {
          setPaidFromAccountId(paidFrom.id);
          filled = true;
        }
        const lineAccount = byId.get(last.lines[0]?.accountId ?? '');
        if (lineAccount?.isActive && isLineAccount(lineAccount)) {
          setLines((ls) => (ls[0] && !ls[0].accountId ? [{ ...ls[0], accountId: lineAccount.id }, ...ls.slice(1)] : ls));
          filled = true;
        }
        if (filled) setDefaultsNote('Filled in from your last expense with this vendor.');
      })
      .catch(() => {
        // Defaults are a convenience; the form works without them.
      });
  };

  const onFilesChosen = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const key = keySeq++;
      setUploads((us) => [...us, { key, file, status: 'uploading' }]);
      uploadAttachment(company.id, file, 'receipt')
        .then((att) => setUpload(key, { status: 'done', attachment: att }))
        .catch((e: unknown) => setUpload(key, { status: 'error', error: e instanceof Error ? e.message : 'Upload failed' }));
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const uploading = uploads.some((u) => u.status === 'uploading');

  const usedLines = () => lines.filter((l) => l.accountId || l.description.trim() || l.amount.trim());

  const validate = (): FormError[] => {
    const errs: FormError[] = [];
    if (!date) errs.push({ message: 'Date is required.', fieldId: 'pur-date' });
    if (!paidFromAccountId) errs.push({ message: 'Choose the bank account or card it was paid from.', fieldId: 'pur-paid-from' });
    const used = usedLines();
    if (used.length < 1) errs.push({ message: 'At least one line is required.', fieldId: lineField(0, 'account') });
    used.forEach((l, i) => {
      const at = lines.indexOf(l);
      if (!l.accountId) errs.push({ message: `Line ${i + 1}: choose a category.`, fieldId: lineField(at, 'account') });
      if (!isPositive(l.amount.trim())) errs.push({ message: `Line ${i + 1}: enter an amount greater than zero.`, fieldId: lineField(at, 'amount') });
    });
    if (uploading) errs.push({ message: 'Wait for receipt uploads to finish.' });
    if (uploads.some((u) => u.status === 'error')) errs.push({ message: 'Remove failed receipt uploads or retry them.', fieldId: 'receipts' });
    return errs;
  };

  const resetForNext = () => {
    // Keep the date and the paid-from account: a batch of receipts usually shares them.
    const next = { date, contactId: '', direction: 'outflow' as const, reference: '', memo: '', lines: [blankLine()] };
    setContactId('');
    setDirection('outflow');
    setReference('');
    setMemo('');
    setLines(next.lines);
    setUploads([]);
    setErrors([]);
    setDefaultsNote(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setBaseline(snapshot({ ...next, paidFrom: paidFromChosen.current ? paidFromAccountId : '', uploads: 0 }));
    idemRef.current = idempotencyKey();
    requestAnimationFrame(() => document.getElementById('pur-vendor')?.focus());
  };

  const submit = (andNew = false) => {
    const errs = validate();
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    create.mutate(
      {
        date,
        contactId: contactId || null,
        paidFromAccountId,
        direction,
        reference: reference.trim() || null,
        memo: memo.trim() || null,
        lines: usedLines().map((l) => ({ accountId: l.accountId, description: l.description.trim(), amount: l.amount.trim() })),
        attachmentIds: uploads.flatMap((u) => (u.status === 'done' && u.attachment ? [u.attachment.id] : [])),
        idempotencyKey: idemRef.current,
      },
      {
        onSuccess: (p) => {
          const title = `Expense saved · ${formatMoney(p.total, p.currency)}`;
          if (andNew) {
            toast.success(title, undefined, { action: { label: 'View', onClick: () => router.push(`/purchases/${p.id}`) } });
            resetForNext();
            return;
          }
          guard.markSaved();
          toast.success('Expense saved');
          router.push(`/purchases/${p.id}`);
        },
        onError: (e) => onError(e, 'Could not save expense'),
      },
    );
  };

  const pending = create.isPending;
  const modKey = useModKeyLabel();
  const shortcut = useSubmitShortcut(() => !pending && !uploading && submit());

  return (
    <>
      <PageHeader
        title={copyOf ? 'Record expense (copy)' : 'Record expense'}
        description="Something you paid for from a bank account or card. Saving records this in your books right away."
      />
      <Card>
        <CardBody className="space-y-5">
          <div {...shortcut} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Date" htmlFor="pur-date" required>
                <DateInput id="pur-date" value={date} onChange={setDate} aria-invalid={invalid.has('pur-date') || undefined} />
              </Field>
              <ContactPicker kind="vendor" id="pur-vendor" label="Vendor" value={contactId || null} onChange={(id) => onVendorChange(id)} clearable placeholder="No vendor" />
              <Field label="Paid from" htmlFor="pur-paid-from" required hint={defaultsNote ?? undefined}>
                <AccountPicker
                  id="pur-paid-from"
                  value={paidFromAccountId}
                  allow={isPaymentAccount}
                  recentKey="purchase-paid-from"
                  createType="asset"
                  invalid={invalid.has('pur-paid-from')}
                  onChange={(v) => {
                    paidFromChosen.current = true;
                    setPaidFromAccountId(v ?? '');
                  }}
                />
              </Field>
              <Field label="Direction" htmlFor="direction" required hint={direction === 'outflow' ? 'Money left the account.' : 'A vendor refund returned money to the account.'}>
                <Select id="direction" value={direction} onChange={(e) => setDirection(e.target.value as 'outflow' | 'inflow')}>
                  <option value="outflow">Paid</option>
                  <option value="inflow">Vendor refund</option>
                </Select>
              </Field>
            </div>
            <p className="-mt-2 flex items-start gap-1.5 text-xs text-stone-500" data-testid="match-note">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>Paid from a connected bank? When the bank line arrives, choose Match so it isn’t counted twice.</span>
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Reference" htmlFor="reference" hint="Receipt or check number.">
                <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
              </Field>
              <Field label="Note" htmlFor="memo" className="sm:col-span-2">
                <Textarea id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} maxLength={1000} />
              </Field>
            </div>

            <div>
              <div className="mb-2 hidden grid-cols-12 gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500 sm:grid">
                <div className="col-span-5">Category</div>
                <div className="col-span-4">Description</div>
                <div className="col-span-2 text-right">Amount</div>
                <div className="col-span-1" />
              </div>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={l.key} className="grid grid-cols-12 items-center gap-2 rounded-md border border-stone-200 p-2 sm:border-0 sm:p-0">
                    <div className="col-span-12 sm:col-span-5">
                      <AccountPicker
                        id={lineField(i, 'account')}
                        aria-label={`Line ${i + 1} category`}
                        value={l.accountId}
                        allow={isLineAccount}
                        prefer={isExpense}
                        preferLabel="Expenses"
                        recentKey="purchase-line-account"
                        createType="expense"
                        invalid={invalid.has(lineField(i, 'account'))}
                        onChange={(v) => setLine(l.key, { accountId: v ?? '' })}
                      />
                    </div>
                    <div className="col-span-7 sm:col-span-4">
                      <Input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} maxLength={500} />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <MoneyInput
                        id={lineField(i, 'amount')}
                        aria-label={`Line ${i + 1} amount`}
                        value={l.amount}
                        aria-invalid={invalid.has(lineField(i, 'amount')) || undefined}
                        onChange={(v) => setLine(l.key, { amount: v })}
                        onKeyDown={(e) => {
                          // Enter on the last line's amount adds a line, like a spreadsheet.
                          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && i === lines.length - 1) {
                            e.preventDefault();
                            addLine();
                          }
                        }}
                      />
                    </div>
                    <div className="col-span-1 flex justify-end">
                      <Button variant="ghost" size="sm" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} disabled={lines.length <= 1}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <Button variant="secondary" size="sm" onClick={addLine}>
                  <Plus className="size-4" /> Add line
                </Button>
                <p className="tabular text-sm font-medium text-stone-800" aria-live="polite">
                  Total {formatMoney(total, cur)}
                </p>
              </div>
            </div>

            <div>
              <Field label="Receipts" htmlFor="receipts" hint="PDF or images, up to 15 MB each. Files upload as soon as they are chosen.">
                <Input id="receipts" ref={fileInputRef} type="file" multiple accept="application/pdf,image/*" onChange={(e) => onFilesChosen(e.target.files)} className="h-auto py-1.5" />
              </Field>
              {uploads.length > 0 && (
                <ul className="mt-2 divide-y divide-stone-100 rounded-md border border-stone-200 text-sm" aria-label="Receipt uploads" aria-busy={uploading}>
                  {uploads.map((u) => (
                    <li key={u.key} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="flex min-w-0 items-center gap-2">
                        {u.status === 'uploading' && <Loader2 className="size-4 shrink-0 animate-spin text-stone-500" aria-hidden />}
                        {u.status === 'done' && <CheckCircle2 className="size-4 shrink-0 text-emerald-600" aria-hidden />}
                        {u.status === 'error' && <XCircle className="size-4 shrink-0 text-red-600" aria-hidden />}
                        <span className="truncate">{u.file.name}</span>
                        <span className="shrink-0 text-xs text-stone-500">{u.status === 'uploading' ? 'Uploading…' : u.status === 'done' ? 'Uploaded' : (u.error ?? 'Failed')}</span>
                      </span>
                      <Button variant="ghost" size="sm" aria-label={`Remove ${u.file.name}`} disabled={u.status === 'uploading'} onClick={() => setUploads((us) => us.filter((x) => x.key !== u.key))}>
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <ErrorSummary errors={errors} />

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4">
            <span className="mr-auto hidden text-xs text-stone-500 sm:inline">{modKey}+Enter to save</span>
            <Button variant="secondary" onClick={() => void guard.leave(() => router.back())} disabled={pending}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={() => submit(true)} loading={pending} disabled={uploading}>
              Save and new
            </Button>
            <Button onClick={() => submit()} loading={pending} disabled={uploading}>
              Save expense
            </Button>
          </div>
        </CardBody>
      </Card>
    </>
  );
}
