'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { DateInput } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { AccountPicker } from '@/components/account-picker';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import { ContactPicker } from '@/components/contact-picker';
import { useAccounts } from '@/lib/queries/accounts';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod, useCreatePayment, useCustomerBalance, useInvoiceForPrefill } from '@/lib/queries/payments';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatMoney, todayIso } from '@/lib/format';
import { useCompany } from '@/components/company-context';
import { useContact } from '@/lib/queries/contacts';
import { HelpTip } from '@/components/ui/term';
import { compareDecimals, isValidDecimal, subtractDecimals, sumDecimals } from '@/lib/decimal';
import { useUnsavedChanges } from '@/lib/use-unsaved-changes';
import { useModKeyLabel, useSubmitShortcut } from '@/lib/use-hotkeys';
import { useRememberedValue } from '@/lib/use-recent';
import type { AccountDto, OpenInvoiceDto } from '@evenbooks/contracts';

/**
 * Oldest-due-first fill, mirroring `allocatePaymentAcrossDocuments` in the
 * domain package: take min(remaining, open) from each invoice until the
 * amount is used up. Returns a map of invoiceId -> amount string.
 */
export function autoApply(amount: string, invoices: OpenInvoiceDto[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isValidDecimal(amount) || compareDecimals(amount, '0') <= 0) return result;
  let remaining = amount;
  const ordered = [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
  for (const inv of ordered) {
    if (compareDecimals(remaining, '0') <= 0) break;
    const take = compareDecimals(remaining, inv.balanceDue) < 0 ? remaining : inv.balanceDue;
    if (compareDecimals(take, '0') > 0) {
      result[inv.id] = sumDecimals([take]);
      remaining = subtractDecimals(remaining, take);
    }
  }
  return result;
}

/** Where a customer payment can be deposited: a bank account or Undeposited Funds. */
const isDepositAccount = (a: AccountDto) => a.role === 'bank' || a.role === 'undeposited_funds';
const isMethod = (v: string | null): v is PaymentMethod => !!v && (PAYMENT_METHODS as readonly string[]).includes(v);
const allocField = (index: number) => `alloc-${index}`;
const decimalOrZero = (v: string) => (isValidDecimal(v) ? v : '0');

/**
 * How the Apply column is filled: `auto` spreads the amount oldest-first, `invoice` keeps it on
 * the invoice the form was opened from (`?invoiceId=`), `manual` is whatever the user typed.
 */
type AllocMode = 'auto' | 'invoice' | 'manual';

/** "$200 extra will be kept as credit for Acme…", or why there is nothing to keep it for. */
export function leftoverMessage(leftover: string, currency: string, customerName: string | null | undefined): string {
  const money = formatMoney(leftover, currency);
  if (!customerName) return `${money} isn't linked to a customer. Choose a customer to keep it as their credit.`;
  return `${money} extra will be kept as credit for ${customerName} (use it on a later invoice, or refund it).`;
}

/**
 * Customer payment form. Remembers the last method and deposit account for
 * this company, preselects the deposit account when only one qualifies, and
 * offers "Record and new" for batches (keeps the date, method and deposit account).
 * Until the user types in the Apply column, the amount is spread over the
 * customer's oldest invoices (or kept on the invoice the form was opened from).
 */
export function PaymentForm() {
  const { company } = useCompany();
  const router = useRouter();
  const sp = useSearchParams();
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const accounts = useAccounts();
  const create = useCreatePayment();

  const prefillInvoiceId = sp.get('invoiceId');
  const prefillContactId = sp.get('contactId');
  const prefillInvoice = useInvoiceForPrefill(prefillInvoiceId);

  const [contactId, setContactId] = React.useState<string | null>(prefillContactId);
  const [pickedName, setPickedName] = React.useState<string | null>(null);
  const [date, setDate] = React.useState(todayIso(company.timeZone));
  const [amount, setAmount] = React.useState('');
  const [method, setMethod] = React.useState<PaymentMethod>('other');
  const [reference, setReference] = React.useState('');
  const [memo, setMemo] = React.useState('');
  const [depositAccountId, setDepositAccountId] = React.useState('');
  const [isRefundableDeposit, setIsRefundableDeposit] = React.useState(false);
  const [allocMode, setAllocMode] = React.useState<AllocMode>(prefillInvoiceId ? 'invoice' : 'auto');
  const [manualAllocations, setManualAllocations] = React.useState<Record<string, string>>({});
  const [errors, setErrors] = React.useState<FormError[]>([]);
  const idemRef = React.useRef(idempotencyKey());
  const prefilled = React.useRef(false);
  const methodChosen = React.useRef(false);
  const depositChosen = React.useRef(false);
  const [lastMethod, rememberMethod] = useRememberedValue('payment-method');
  const [lastDeposit, rememberDeposit] = useRememberedValue('payment-deposit-account');

  // Dirty tracking covers what the user typed; method and deposit account are remembered defaults,
  // and allocations filled in automatically follow the amount, so only hand-typed ones count.
  const snapshot = (s: { contactId: string | null; date: string; amount: string; reference: string; memo: string; isRefundableDeposit: boolean; allocations: Record<string, string> | null }) =>
    JSON.stringify([s.contactId ?? '', s.date, s.amount, s.reference, s.memo, s.isRefundableDeposit, s.allocations ? Object.entries(s.allocations).sort() : null]);
  const [baseline, setBaseline] = React.useState(() =>
    snapshot({ contactId: prefillContactId, date: todayIso(company.timeZone), amount: '', reference: '', memo: '', isRefundableDeposit: false, allocations: null }),
  );
  const dirty = snapshot({ contactId, date, amount, reference, memo, isRefundableDeposit, allocations: allocMode === 'manual' ? manualAllocations : null }) !== baseline;
  const guard = useUnsavedChanges(dirty);

  // Prefill from ?invoiceId= once the invoice arrives: customer, amount and (through `invoice` mode) its allocation.
  React.useEffect(() => {
    const inv = prefillInvoice.data;
    if (!inv || prefilled.current) return;
    prefilled.current = true;
    const open = compareDecimals(inv.balanceDue, '0') > 0;
    const next = { contactId: inv.contactId as string | null, amount: open ? inv.balanceDue : '' };
    setContactId(next.contactId);
    setAmount(next.amount);
    if (!open) setAllocMode('auto');
    // What came from the invoice is not an unsaved edit.
    setBaseline(snapshot({ ...next, date: todayIso(company.timeZone), reference: '', memo: '', isRefundableDeposit: false, allocations: null }));
  }, [prefillInvoice.data, company.timeZone]);

  // Remembered method.
  React.useEffect(() => {
    if (!methodChosen.current && isMethod(lastMethod)) setMethod(lastMethod);
  }, [lastMethod]);

  const depositAccounts = React.useMemo(() => (accounts.data ?? []).filter((a) => a.isActive && isDepositAccount(a)), [accounts.data]);

  // Remembered deposit account, else the only one that qualifies.
  React.useEffect(() => {
    if (depositChosen.current || depositAccountId || !accounts.data) return;
    const remembered = lastDeposit ? depositAccounts.find((a) => a.id === lastDeposit) : undefined;
    if (remembered) setDepositAccountId(remembered.id);
    else if (depositAccounts.length === 1) setDepositAccountId(depositAccounts[0]!.id);
  }, [accounts.data, depositAccounts, lastDeposit, depositAccountId]);

  const balance = useCustomerBalance(contactId);
  const contact = useContact(contactId ?? '');
  const customerName = contactId ? (contact.data?.name ?? pickedName) : null;
  const openInvoices = React.useMemo(() => balance.data?.openInvoices ?? [], [balance.data]);
  const cur = company.baseCurrency;
  const invalid = invalidFields(errors);
  const amountValid = isValidDecimal(amount) && compareDecimals(amount, '0') > 0;

  // The invoice the form was opened from, while it still belongs to the chosen customer.
  const pinned = allocMode === 'invoice' && prefillInvoice.data && prefillInvoice.data.contactId === contactId ? prefillInvoice.data : null;
  const pinnedBalance = pinned ? (openInvoices.find((i) => i.id === pinned.id)?.balanceDue ?? pinned.balanceDue) : null;

  const autoAllocations = React.useMemo<Record<string, string>>(() => {
    if (isRefundableDeposit || !amountValid) return {};
    if (pinned && pinnedBalance) {
      if (compareDecimals(pinnedBalance, '0') <= 0) return {};
      // A smaller payment lowers what goes on the invoice instead of over-applying.
      return { [pinned.id]: compareDecimals(amount, pinnedBalance) < 0 ? sumDecimals([amount]) : pinnedBalance };
    }
    // Opened from an invoice that hasn't loaded yet: wait rather than spread it elsewhere.
    if (allocMode === 'invoice' && !prefillInvoice.data) return {};
    return autoApply(amount, openInvoices);
  }, [isRefundableDeposit, amountValid, amount, pinned, pinnedBalance, allocMode, prefillInvoice.data, openInvoices]);
  const allocations = isRefundableDeposit ? {} : allocMode === 'manual' ? manualAllocations : autoAllocations;

  const appliedTotal = sumDecimals(Object.values(allocations).map(decimalOrZero));
  const unapplied = subtractDecimals(decimalOrZero(amount || '0'), appliedTotal);
  const overApplied = compareDecimals(appliedTotal, decimalOrZero(amount || '0')) > 0;
  const leftover = !isRefundableDeposit && compareDecimals(unapplied, '0') > 0 ? unapplied : null;

  // "Leaves $X still due on INV-1004" for each invoice the payment only partly covers.
  const stillDue = Object.entries(allocations).flatMap(([invoiceId, v]) => {
    const open = openInvoices.find((i) => i.id === invoiceId);
    const inv = open ?? (pinned?.id === invoiceId ? { number: pinned.number ?? 'this invoice', balanceDue: pinned.balanceDue } : null);
    if (!inv || !isValidDecimal(v) || compareDecimals(v, '0') <= 0 || compareDecimals(v, inv.balanceDue) >= 0) return [];
    return [{ invoiceId, number: inv.number, left: subtractDecimals(inv.balanceDue, v) }];
  });

  const setAllocation = (invoiceId: string, value: string) => {
    // The first hand edit freezes what was filled in automatically, then applies the change.
    const next = { ...(allocMode === 'manual' ? manualAllocations : autoAllocations) };
    if (value.trim()) next[invoiceId] = value;
    else delete next[invoiceId];
    setManualAllocations(next);
    setAllocMode('manual');
  };

  const applyOldestFirst = () => {
    setAllocMode('auto');
    setManualAllocations({});
  };

  const onContactChange = (id: string | null, picked: { name: string } | null) => {
    setContactId(id);
    setPickedName(picked?.name ?? null);
    applyOldestFirst();
  };

  const onDepositToggle = (checked: boolean) => {
    setIsRefundableDeposit(checked);
    if (checked) applyOldestFirst();
  };

  const validate = (): FormError[] => {
    const errs: FormError[] = [];
    if (!date) errs.push({ message: 'Date is required.', fieldId: 'pay-date' });
    if (!amount.trim() || !amountValid) errs.push({ message: 'Enter an amount greater than zero.', fieldId: 'pay-amount' });
    if (!depositAccountId) errs.push({ message: 'Choose where the money went: a bank account, or Undeposited Funds if you haven’t deposited it yet.', fieldId: 'pay-deposit' });
    if (!isRefundableDeposit) {
      if (Object.keys(allocations).length > 0 && !contactId) errs.push({ message: 'Choose a customer to apply the payment to invoices.', fieldId: 'pay-customer' });
      for (const [invoiceId, v] of Object.entries(allocations)) {
        const index = openInvoices.findIndex((i) => i.id === invoiceId);
        const inv = openInvoices[index];
        const label = inv ? `Invoice ${inv.number}` : 'An invoice';
        const fieldId = index >= 0 ? allocField(index) : undefined;
        if (!isValidDecimal(v) || compareDecimals(v, '0') <= 0) errs.push({ message: `${label}: enter an amount greater than zero.`, fieldId });
        else if (inv && compareDecimals(v, inv.balanceDue) > 0) errs.push({ message: `${label}: only ${formatMoney(inv.balanceDue, cur)} is still due.`, fieldId });
      }
      if (overApplied)
        errs.push({
          message: `You applied ${formatMoney(appliedTotal, cur)} to invoices, but the payment is ${formatMoney(decimalOrZero(amount || '0'), cur)}. Lower the amounts, or use Apply oldest first.`,
          fieldId: 'pay-amount',
        });
    }
    return errs;
  };

  const resetForNext = () => {
    // Keep the date, method and deposit account: a batch of cheques usually shares them.
    setContactId(null);
    setPickedName(null);
    setAmount('');
    setReference('');
    setMemo('');
    setIsRefundableDeposit(false);
    applyOldestFirst();
    setErrors([]);
    setBaseline(snapshot({ contactId: null, date, amount: '', reference: '', memo: '', isRefundableDeposit: false, allocations: null }));
    idemRef.current = idempotencyKey();
    if (prefillInvoiceId || prefillContactId) router.replace('/payments/new', { scroll: false });
    requestAnimationFrame(() => document.getElementById('pay-customer')?.focus());
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
        contactId: contactId ?? null,
        date,
        amount: amount.trim(),
        method,
        reference: reference.trim() || null,
        memo: memo.trim() || null,
        depositAccountId,
        isRefundableDeposit,
        allocations: isRefundableDeposit ? [] : Object.entries(allocations).map(([invoiceId, a]) => ({ invoiceId, amount: a.trim() })),
        idempotencyKey: idemRef.current,
      },
      {
        onSuccess: (p) => {
          rememberMethod(method);
          rememberDeposit(depositAccountId);
          const credit = !p.isRefundableDeposit && p.contactId && compareDecimals(p.unappliedAmount, '0') > 0 ? `${formatMoney(p.unappliedAmount, p.currency)} extra is kept as credit for ${p.contactName ?? customerName ?? 'the customer'}.` : undefined;
          if (andNew) {
            toast.success(`Payment recorded · ${formatMoney(p.amount, p.currency)}`, credit ?? p.contactName ?? undefined, {
              action: { label: 'View', onClick: () => router.push(`/payments/${p.id}`) },
            });
            resetForNext();
            return;
          }
          guard.markSaved();
          toast.success('Payment recorded', credit);
          router.push(`/payments/${p.id}`);
        },
        onError: (e) => onError(e, 'Could not record payment'),
      },
    );
  };

  const pending = create.isPending;
  const modKey = useModKeyLabel();
  const shortcut = useSubmitShortcut(() => !pending && submit());

  return (
    <div {...shortcut}>
      <PageHeader title="Record payment" description="Money a customer paid you. It goes toward their oldest unpaid invoices first; you can change how it’s split below." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardBody className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <ContactPicker kind="customer" id="pay-customer" value={contactId} onChange={onContactChange} clearable invalid={invalid.has('pay-customer')} />
              <Field label="Date" htmlFor="pay-date" required>
                <DateInput id="pay-date" value={date} onChange={setDate} aria-invalid={invalid.has('pay-date') || undefined} />
              </Field>
              <Field label="Amount" htmlFor="pay-amount" required>
                <MoneyInput id="pay-amount" value={amount} onChange={setAmount} aria-invalid={invalid.has('pay-amount') || undefined} />
              </Field>
              <Field label="Method" htmlFor="method" required>
                <Select
                  id="method"
                  value={method}
                  onChange={(e) => {
                    methodChosen.current = true;
                    setMethod(e.target.value as PaymentMethod);
                  }}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Reference" htmlFor="reference" hint="Check number, transaction id…">
                <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
              </Field>
              <Field
                label="Where did the money go?"
                htmlFor="pay-deposit"
                required
                hint={
                  <>
                    The bank account it went into. For checks or cash you haven&rsquo;t deposited yet, choose Undeposited Funds
                    <HelpTip id="undeposited-funds" label="What is Undeposited Funds?" className="ml-0.5 size-5" />
                  </>
                }
              >
                <AccountPicker
                  id="pay-deposit"
                  value={depositAccountId}
                  allow={isDepositAccount}
                  recentKey="payment-deposit-account"
                  createType={false}
                  invalid={invalid.has('pay-deposit')}
                  onChange={(v) => {
                    depositChosen.current = true;
                    setDepositAccountId(v ?? '');
                  }}
                />
              </Field>
            </div>
            <Field label="Memo" htmlFor="memo">
              <Textarea id="memo" value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} maxLength={1000} />
            </Field>
            <details className="group rounded-md border border-stone-200 px-3 py-2" open={isRefundableDeposit || undefined}>
              <summary className="cursor-pointer text-sm font-medium text-stone-700">More options</summary>
              <div className="mt-2 space-y-1">
                <Checkbox label="This is a deposit I’ll give back later, like a security deposit" checked={isRefundableDeposit} onChange={(e) => onDepositToggle(e.target.checked)} />
                <p className="text-xs text-stone-500" role="note">
                  It isn&rsquo;t income and isn&rsquo;t applied to invoices. You can refund it, or apply it to an invoice later, from the payment&rsquo;s page.
                </p>
              </div>
            </details>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Summary" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-y-2 text-sm" aria-live="polite">
              <dt className="text-stone-500">Amount</dt>
              <dd className="tabular text-right font-medium">{formatMoney(decimalOrZero(amount || '0'), cur)}</dd>
              <dt className="text-stone-500">Applied to invoices</dt>
              <dd className="tabular text-right" data-testid="applied-total">
                {formatMoney(appliedTotal, cur)}
              </dd>
              <dt className="text-stone-500">{isRefundableDeposit ? 'Held as a deposit' : 'Kept as credit'}</dt>
              <dd className={`tabular text-right ${overApplied ? 'font-semibold text-red-700' : ''}`} data-testid="unapplied-total">
                {formatMoney(unapplied, cur)}
              </dd>
            </dl>
            <div className="mt-3 space-y-1 text-xs text-stone-600" aria-live="polite">
              {overApplied && (
                <p className="text-red-700" role="alert">
                  You applied more than the payment amount. Lower the amounts, or use Apply oldest first.
                </p>
              )}
              {stillDue.map((d) => (
                <p key={d.invoiceId} data-testid="still-due">
                  Leaves {formatMoney(d.left, cur)} still due on {d.number}.
                </p>
              ))}
              {leftover && <p data-testid="leftover-credit">{leftoverMessage(leftover, cur, customerName)}</p>}
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader
            title="Apply to invoices"
            description={
              contactId
                ? allocMode === 'manual'
                  ? 'Amounts you typed. Apply oldest first spreads the payment over the oldest invoices again.'
                  : allocMode === 'invoice' && pinned
                    ? `Going toward ${pinned.number ?? 'this invoice'}. Type amounts to split it differently.`
                    : 'Filled in oldest first. Type amounts to split it differently.'
                : 'Choose a customer to see their unpaid invoices.'
            }
            actions={
              <Button variant="secondary" size="sm" disabled={isRefundableDeposit || openInvoices.length === 0 || !amountValid} onClick={applyOldestFirst}>
                Apply oldest first
              </Button>
            }
          />
          {isRefundableDeposit && (
            <CardBody>
              <p className="text-sm text-stone-500">A deposit you&rsquo;ll give back isn&rsquo;t applied to invoices.</p>
            </CardBody>
          )}
          {!isRefundableDeposit && contactId && balance.isPending && <Spinner />}
          {!isRefundableDeposit && balance.isError && <ErrorNotice error={balance.error} onRetry={() => balance.refetch()} />}
          {!isRefundableDeposit && contactId && balance.data && openInvoices.length === 0 && (
            <CardBody>
              <EmptyState compact title="No unpaid invoices" description="The whole payment will be kept as credit for this customer." />
            </CardBody>
          )}
          {!isRefundableDeposit && openInvoices.length > 0 && (
            <Table aria-label="Open invoices">
              <THead>
                <TR>
                  <TH>Invoice</TH>
                  <TH className="hidden sm:table-cell">Issued</TH>
                  <TH>Due</TH>
                  <TH numeric className="hidden md:table-cell">
                    Total
                  </TH>
                  <TH numeric>Balance due</TH>
                  <TH numeric className="w-40">
                    Apply
                  </TH>
                </TR>
              </THead>
              <TBody>
                {openInvoices.map((inv, index) => {
                  const v = allocations[inv.id] ?? '';
                  const tooMuch = !!v && isValidDecimal(v) && compareDecimals(v, inv.balanceDue) > 0;
                  return (
                    <TR key={inv.id}>
                      <TD>
                        <Link href={`/invoices/${inv.id}`} className="font-medium text-brand-700 hover:underline">
                          {inv.number}
                        </Link>
                        {inv.isOverdue && (
                          <Badge tone="red" className="ml-2">
                            Overdue
                          </Badge>
                        )}
                      </TD>
                      <TD className="hidden sm:table-cell">{formatDate(inv.issueDate)}</TD>
                      <TD>{formatDate(inv.dueDate)}</TD>
                      <TD numeric className="hidden md:table-cell">
                        {formatMoney(inv.total, cur)}
                      </TD>
                      <TD numeric>{formatMoney(inv.balanceDue, cur)}</TD>
                      <TD numeric>
                        <MoneyInput
                          id={allocField(index)}
                          aria-label={`Apply to invoice ${inv.number}`}
                          value={v}
                          aria-invalid={tooMuch || invalid.has(allocField(index)) || undefined}
                          onChange={(val) => setAllocation(inv.id, val)}
                        />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <ErrorSummary errors={errors} />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 pt-4">
        <span className="mr-auto hidden text-xs text-stone-500 sm:inline">{modKey}+Enter to record</span>
        <Button variant="secondary" onClick={() => void guard.leave(() => router.back())} disabled={pending}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => submit(true)} loading={pending}>
          Record and new
        </Button>
        <Button onClick={() => submit()} loading={pending}>
          Record payment
        </Button>
      </div>
    </div>
  );
}
