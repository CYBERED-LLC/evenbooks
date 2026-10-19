'use client';
import * as React from 'react';
import Link from 'next/link';
import type { AllocationDto, PaymentDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, ErrorNotice, PageHeader, Spinner } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { DateInput } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { BackLink } from '@/components/ui/list';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { useToast } from '@/components/ui/toast';
import {
  useAllocatePayment,
  useCustomerBalance,
  usePayment,
  useRefunds,
  useReverseAllocation,
  useVoidPayment,
} from '@/lib/queries/payments';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatDateTime, formatMoney, isZeroDecimal } from '@/lib/format';
import { useToday } from '@/components/company-context';
import { compareDecimals, isValidDecimal, subtractDecimals, sumDecimals } from '@/lib/decimal';
import { useDeleteRecordAction } from '@/components/delete-record-dialog';
import { ActionMenu } from '@/components/ui/action-menu';
import { Ban, Undo2 } from 'lucide-react';
import { RefundsTable, methodLabel } from '../view';
import { RefundDialog } from '../refund-dialog';
import { Term } from '@/components/ui/term';

export function PaymentDetailView({ id, applyTo }: { id: string; /** Open "Apply to invoices" with this invoice filled in (`?apply=`). */ applyTo?: string }) {
  const q = usePayment(id);
  const refunds = useRefunds({ paymentId: id });
  const [applying, setApplying] = React.useState(Boolean(applyTo));
  const [refunding, setRefunding] = React.useState(false);
  const deleteAction = useDeleteRecordAction('payment', id, { redirectTo: '/payments' });
  const [voiding, setVoiding] = React.useState(false);
  const [reversing, setReversing] = React.useState<AllocationDto | null>(null);

  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  const cur = p.currency;
  const isVoid = p.status === 'void';
  const hasUnapplied = !isVoid && !isZeroDecimal(p.unappliedAmount);
  const hasAllocations = !isZeroDecimal(p.amountAllocated);
  const hasRefunds = !isZeroDecimal(p.amountRefunded);
  const voidBlocked = hasAllocations || hasRefunds;

  return (
    <>
      <BackLink listPath="/payments" label="Payments received" />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.contactName ? `Payment from ${p.contactName}` : 'Payment'}
            {isVoid && <Badge tone="neutral">Void</Badge>}
            {p.isRefundableDeposit && <Badge tone="purple">Refundable deposit</Badge>}
            {p.processorChargeId && <Badge tone="blue">Paid online</Badge>}
          </span>
        }
        description={p.memo}
        actions={
          <>
            {hasUnapplied && p.contactId && <Button onClick={() => setApplying(true)}>Apply to invoices…</Button>}
            <ActionMenu
              groups={[
                [hasUnapplied && { label: 'Refund…', icon: Undo2, description: `Give back some of the ${formatMoney(p.unappliedAmount, cur)} credit`, onSelect: () => setRefunding(true) }],
                [
                  !isVoid && {
                    label: 'Void…',
                    icon: Ban,
                    tone: 'danger',
                    disabled: voidBlocked || Boolean(p.processorChargeId),
                    description: p.processorChargeId
                      ? 'Collected online: refund it through the processor from the invoice page'
                      : voidBlocked
                        ? `First ${[hasAllocations && 'remove it from its invoices', hasRefunds && 'void its refunds'].filter(Boolean).join(' and ')}`
                        : 'Marks it Void; it stays in your records',
                    onSelect: () => setVoiding(true),
                  },
                  !p.processorChargeId && deleteAction.item,
                ],
              ]}
            />
          </>
        }
      />
      {deleteAction.dialog}
      {isVoid && (
        <div role="status" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span className="font-medium">Voided.</span> {p.voidReason && <span>Reason: “{p.voidReason}”.</span>} It stays in your records, and your reports leave it out.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card>
            <CardHeader title="Paid toward" description="Invoices this payment went toward." />
            {p.allocations.length === 0 && (
              <CardBody>
                <EmptyState compact title="Not applied to any invoice" description={hasUnapplied ? 'Use “Apply to invoices…” to settle open invoices with this payment.' : undefined} />
              </CardBody>
            )}
            {p.allocations.length > 0 && (
              <Table aria-label="Paid toward">
                <THead>
                  <TR>
                    <TH>Invoice</TH>
                    <TH className="w-28">Date</TH>
                    <TH numeric>Amount</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </TR>
                </THead>
                <TBody>
                  {p.allocations.map((a) => (
                    <TR key={a.id} className={a.status === 'reversed' ? 'text-stone-400' : undefined}>
                      <TD>
                        <Link href={`/invoices/${a.invoiceId}`} className="font-medium text-brand-700 hover:underline">
                          {a.invoiceNumber ?? 'Invoice'}
                        </Link>
                        {a.status === 'reversed' && (
                          <Badge tone="neutral" className="ml-2">
                            Removed
                          </Badge>
                        )}
                      </TD>
                      <TD>{formatDate(a.date)}</TD>
                      <TD numeric className={a.status === 'reversed' ? 'line-through' : undefined}>
                        {formatMoney(a.amount, cur)}
                      </TD>
                      <TD className="text-right">
                        {a.status === 'active' && !isVoid && (
                          <Button variant="ghost" size="sm" onClick={() => setReversing(a)}>
                            Remove from invoice…
                          </Button>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Refunds" description="Money you gave back to the customer from this payment’s credit." />
            {refunds.isPending && <Spinner />}
            {refunds.isError && <ErrorNotice error={refunds.error} onRetry={() => refunds.refetch()} />}
            {refunds.data && refunds.data.length === 0 && (
              <CardBody>
                <EmptyState compact title="No refunds" />
              </CardBody>
            )}
            {refunds.data && refunds.data.length > 0 && <RefundsTable refunds={refunds.data} currency={cur} showSource={false} />}
          </Card>
        </div>

        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-stone-500">Date</dt>
              <dd>{formatDate(p.date)}</dd>
              <dt className="text-stone-500">Customer</dt>
              <dd>
                {p.contactId ? (
                  <Link href={`/contacts/${p.contactId}`} className="text-brand-700 hover:underline">
                    {p.contactName ?? 'Customer'}
                  </Link>
                ) : (
                  '—'
                )}
              </dd>
              <dt className="text-stone-500">Amount</dt>
              <dd className="tabular font-medium" data-testid="payment-amount">
                {formatMoney(p.amount, cur)}
              </dd>
              <dt className="text-stone-500">Applied to invoices</dt>
              <dd className="tabular" data-testid="payment-allocated">
                {formatMoney(p.amountAllocated, cur)}
              </dd>
              <dt className="text-stone-500">Refunded</dt>
              <dd className="tabular" data-testid="payment-refunded">
                {formatMoney(p.amountRefunded, cur)}
              </dd>
              <dt className="text-stone-500">
                <Term id="unapplied" />
              </dt>
              <dd className={`tabular ${hasUnapplied ? 'font-semibold text-amber-700' : ''}`} data-testid="payment-unapplied">
                {formatMoney(p.unappliedAmount, cur)}
              </dd>
              <dt className="text-stone-500">Money went to</dt>
              <dd>{p.depositAccountName ?? p.depositAccountId}</dd>
              <dt className="text-stone-500">Method</dt>
              <dd>{methodLabel(p.method)}</dd>
              <dt className="text-stone-500">Reference</dt>
              <dd>{p.reference ?? '—'}</dd>
              {p.bankTransactionId && (
                <>
                  <dt className="text-stone-500">Bank transaction</dt>
                  <dd>
                    <Link className="text-brand-700 underline" href={`/banking/inbox?transactionId=${p.bankTransactionId}`}>
                      View
                    </Link>
                  </dd>
                </>
              )}
              <dt className="text-stone-500">Created</dt>
              <dd>{formatDateTime(p.createdAt)}</dd>
            </dl>
            <details className="mt-3 border-t border-stone-100 pt-2 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-stone-500 hover:text-stone-800">Accounting details</summary>
              <dl className="mt-2 grid grid-cols-2 gap-y-2">
                <dt className="text-stone-500">Journal entry</dt>
                <dd>
                  <Link className="text-brand-700 underline" href={`/journal/${p.journalEntryId}`}>
                    View entry
                  </Link>
                </dd>
                {p.voidJournalEntryId && (
                  <>
                    <dt className="text-stone-500">Void entry</dt>
                    <dd>
                      <Link className="text-brand-700 underline" href={`/journal/${p.voidJournalEntryId}`}>
                        View reversal
                      </Link>
                    </dd>
                  </>
                )}
                {p.allocations.map((a) =>
                  a.journalEntryId ? (
                    <React.Fragment key={a.id}>
                      <dt className="text-stone-500">Applied to {a.invoiceNumber ?? 'invoice'}</dt>
                      <dd className="flex gap-2">
                        <Link className="text-brand-700 underline" href={`/journal/${a.journalEntryId}`}>
                          Entry
                        </Link>
                        {a.reversalJournalEntryId && (
                          <Link className="text-brand-700 underline" href={`/journal/${a.reversalJournalEntryId}`}>
                            Reversal
                          </Link>
                        )}
                      </dd>
                    </React.Fragment>
                  ) : null,
                )}
                <dt className="text-stone-500">Currency</dt>
                <dd>{cur}</dd>
              </dl>
            </details>
          </CardBody>
        </Card>
      </div>

      {applying && hasUnapplied && p.contactId && <ApplyDialog payment={p} contactId={p.contactId} initialInvoiceId={applyTo} onClose={() => setApplying(false)} />}
      {refunding && (
        <RefundDialog
          source={{ type: 'payment', id: p.id, max: p.unappliedAmount, date: p.date, currency: cur, defaultFromAccountId: p.depositAccountId, defaultMethod: p.method }}
          onClose={() => setRefunding(false)}
        />
      )}
      {voiding && <VoidDialog payment={p} onClose={() => setVoiding(false)} />}
      {reversing && <ReverseDialog allocation={reversing} currency={cur} onClose={() => setReversing(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Apply to invoices
// ---------------------------------------------------------------------------
const applyField = (index: number) => `apply-${index}`;
const decimalOrZero = (v: string) => (isValidDecimal(v) ? v : '0');

function ApplyDialog({ payment, contactId, initialInvoiceId, onClose }: { payment: PaymentDto; contactId: string; initialInvoiceId?: string; onClose: () => void }) {
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const allocate = useAllocatePayment(payment.id);
  const balance = useCustomerBalance(contactId);
  const today = useToday();
  const [date, setDate] = React.useState(today);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [errors, setErrors] = React.useState<FormError[]>([]);
  const idem = React.useRef(idempotencyKey());
  const cur = payment.currency;
  const invalid = invalidFields(errors);

  const openInvoices = React.useMemo(() => balance.data?.openInvoices ?? [], [balance.data]);
  const total = sumDecimals(Object.values(values).map(decimalOrZero));

  // Opened from an invoice ("Apply the $200 payment"): fill that invoice with as much as fits, once.
  const prefilled = React.useRef(false);
  React.useEffect(() => {
    if (prefilled.current || !initialInvoiceId) return;
    const inv = openInvoices.find((i) => i.id === initialInvoiceId);
    if (!inv) return;
    prefilled.current = true;
    setValues({ [inv.id]: compareDecimals(payment.unappliedAmount, inv.balanceDue) < 0 ? payment.unappliedAmount : inv.balanceDue });
  }, [initialInvoiceId, openInvoices, payment.unappliedAmount]);
  const remaining = subtractDecimals(payment.unappliedAmount, total);
  const over = compareDecimals(total, payment.unappliedAmount) > 0;
  const dirty = Object.keys(values).length > 0 || date !== today;

  const setValue = (invoiceId: string, v: string) =>
    setValues((prev) => {
      const next = { ...prev };
      if (v.trim()) next[invoiceId] = v;
      else delete next[invoiceId];
      return next;
    });

  const submit = () => {
    if (allocate.isPending) return;
    const errs: FormError[] = [];
    const entries = Object.entries(values);
    if (entries.length === 0) errs.push({ message: 'Enter an amount for at least one invoice.', fieldId: openInvoices.length ? applyField(0) : undefined });
    for (const [invoiceId, v] of entries) {
      const index = openInvoices.findIndex((i) => i.id === invoiceId);
      const inv = openInvoices[index];
      const label = inv ? `Invoice ${inv.number}` : 'An invoice';
      const fieldId = index >= 0 ? applyField(index) : undefined;
      if (!isValidDecimal(v) || compareDecimals(v, '0') <= 0) errs.push({ message: `${label}: enter an amount greater than zero.`, fieldId });
      else if (inv && compareDecimals(v, inv.balanceDue) > 0) errs.push({ message: `${label}: only ${formatMoney(inv.balanceDue, cur)} is still due.`, fieldId });
    }
    if (over) errs.push({ message: `You're applying ${formatMoney(total, cur)}, but this payment only has ${formatMoney(payment.unappliedAmount, cur)} of credit to use.` });
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    allocate.mutate(
      { version: payment.version, date: date || undefined, allocations: entries.map(([invoiceId, amount]) => ({ invoiceId, amount: amount.trim() })), idempotencyKey: idem.current },
      {
        onSuccess: () => {
          toast.success('Payment applied');
          onClose();
        },
        onError: (e) => onError(e, 'Could not apply payment'),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty && !allocate.isPending}
      size="lg"
      title="Apply to invoices"
      description={`${formatMoney(payment.unappliedAmount, cur)} of this payment is credit to use. Choose how much goes toward each invoice.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={allocate.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={allocate.isPending} disabled={Object.keys(values).length === 0 || over}>
            Apply
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Date applied" htmlFor="apply-date" hint="When the invoice counts as paid. Usually today; use a later date if that month is locked.">
          <DateInput id="apply-date" value={date} min={payment.date} onChange={setDate} />
        </Field>
        {balance.isPending && <Spinner />}
        {balance.isError && <ErrorNotice error={balance.error} onRetry={() => balance.refetch()} />}
        {balance.data && openInvoices.length === 0 && <EmptyState title="No open invoices for this customer" />}
        {openInvoices.length > 0 && (
          <Table aria-label="Open invoices">
            <THead>
              <TR>
                <TH>Invoice</TH>
                <TH>Due</TH>
                <TH numeric>Balance due</TH>
                <TH numeric className="w-36">
                  Apply
                </TH>
              </TR>
            </THead>
            <TBody>
              {openInvoices.map((inv, index) => (
                <TR key={inv.id}>
                  <TD>
                    {inv.number}
                    {inv.isOverdue && (
                      <Badge tone="red" className="ml-2">
                        Overdue
                      </Badge>
                    )}
                  </TD>
                  <TD>{formatDate(inv.dueDate)}</TD>
                  <TD numeric>{formatMoney(inv.balanceDue, cur)}</TD>
                  <TD numeric>
                    <MoneyInput
                      id={applyField(index)}
                      data-autofocus={index === 0 ? true : undefined}
                      aria-label={`Apply to invoice ${inv.number}`}
                      aria-invalid={invalid.has(applyField(index)) || undefined}
                      value={values[inv.id] ?? ''}
                      onChange={(v) => setValue(inv.id, v)}
                    />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
        <p className={`tabular text-right text-sm ${over ? 'font-semibold text-red-700' : 'text-stone-600'}`} aria-live="polite">
          Applying {formatMoney(total, cur)} · {formatMoney(remaining, cur)} left as credit
        </p>
        <ErrorSummary errors={errors} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Void payment
// ---------------------------------------------------------------------------
function VoidDialog({ payment, onClose }: { payment: PaymentDto; onClose: () => void }) {
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const voidPayment = useVoidPayment(payment.id);
  const [reason, setReason] = React.useState('');
  const [date, setDate] = React.useState('');
  const idem = React.useRef(idempotencyKey());

  const submit = () => {
    if (!reason.trim() || voidPayment.isPending) return;
    voidPayment.mutate(
      { version: payment.version, reason: reason.trim(), date: date || undefined, idempotencyKey: idem.current },
      {
        onSuccess: () => {
          toast.success('Payment voided');
          onClose();
        },
        onError: (e) => onError(e, 'Could not void payment'),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      onSubmit={submit}
      dirty={(!!reason.trim() || !!date) && !voidPayment.isPending}
      title="Void payment"
      description="The payment stays in your records marked Void, and your reports drop it. Nothing is deleted."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={voidPayment.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={voidPayment.isPending} disabled={!reason.trim()}>
            Void payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Reason" htmlFor="void-reason" required>
          <Textarea id="void-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <Field label="Void date" htmlFor="void-date" hint={`Leave blank to void it as of ${formatDate(payment.date)}, the payment date. Use a later date if that month is locked.`}>
          <DateInput id="void-date" value={date} min={payment.date} onChange={setDate} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reverse allocation
// ---------------------------------------------------------------------------
function ReverseDialog({ allocation, currency, onClose }: { allocation: AllocationDto; currency: string; onClose: () => void }) {
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const reverse = useReverseAllocation();
  const [reason, setReason] = React.useState('');
  const [date, setDate] = React.useState('');
  const idem = React.useRef(idempotencyKey());

  const submit = () => {
    if (!reason.trim() || reverse.isPending) return;
    reverse.mutate(
      { allocationId: allocation.id, input: { reason: reason.trim(), date: date || undefined, idempotencyKey: idem.current } },
      {
        onSuccess: () => {
          toast.success('Removed from invoice');
          onClose();
        },
        onError: (e) => onError(e, 'Could not remove the payment from the invoice'),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      onSubmit={submit}
      dirty={(!!reason.trim() || !!date) && !reverse.isPending}
      title="Remove from invoice"
      description={`Takes ${formatMoney(allocation.amount, currency)} off invoice ${allocation.invoiceNumber ?? ''}. The customer owes that amount again, and the money becomes credit to use on this payment.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={reverse.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={reverse.isPending} disabled={!reason.trim()}>
            Remove from invoice
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Reason" htmlFor="reverse-reason" required>
          <Textarea id="reverse-reason" data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        <Field label="Date" htmlFor="reverse-date" hint={`Leave blank to use ${formatDate(allocation.date)}, when it was applied. Use a later date if that month is locked.`}>
          <DateInput id="reverse-date" value={date} min={allocation.date} onChange={setDate} />
        </Field>
      </div>
    </Dialog>
  );
}
