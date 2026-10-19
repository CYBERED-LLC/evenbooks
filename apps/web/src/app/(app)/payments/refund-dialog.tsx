'use client';
import * as React from 'react';
import type { AccountDto } from '@evenbooks/contracts';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/input';
import { MoneyInput } from '@/components/ui/money-input';
import { DateInput } from '@/components/ui/date-input';
import { ErrorSummary, focusFirstError, invalidFields, type FormError } from '@/components/ui/error-summary';
import { AccountPicker } from '@/components/account-picker';
import { useToast } from '@/components/ui/toast';
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, type PaymentMethod, useCreateRefund } from '@/lib/queries/payments';
import { useMutationErrorHandler } from '@/lib/queries/use-mutation-error';
import { useAccounts } from '@/lib/queries/accounts';
import { idempotencyKey } from '@/lib/api-client';
import { formatDate, formatMoney } from '@/lib/format';
import { useToday } from '@/components/company-context';
import { compareDecimals, isValidDecimal } from '@/lib/decimal';

/** Where a refund can be paid from. */
export const isRefundSource = (a: AccountDto) => a.role === 'bank' || a.role === 'undeposited_funds' || a.role === 'credit_card';

export interface RefundSource {
  type: 'payment' | 'credit_note';
  id: string;
  /** Most that can be refunded: the payment's credit to use, or the credit note's balance. */
  max: string;
  /** The refund can't be dated before the payment or credit note. */
  date: string;
  currency: string;
  /** Prefilled "From account" (the payment's deposit account) when a refund can be paid from it. */
  defaultFromAccountId?: string;
  defaultMethod?: string;
}

/**
 * Give money back to a customer, from a payment's unused credit or a credit note's balance.
 * Shared by the payment and credit note pages.
 */
export function RefundDialog({ source, onClose }: { source: RefundSource; onClose: () => void }) {
  const toast = useToast();
  const onError = useMutationErrorHandler();
  const refund = useCreateRefund();
  const accounts = useAccounts();
  const initialMethod: PaymentMethod = (PAYMENT_METHODS as readonly string[]).includes(source.defaultMethod ?? '') ? (source.defaultMethod as PaymentMethod) : 'other';
  const preferred = accounts.data?.find((a) => a.id === source.defaultFromAccountId);
  const defaultFrom = preferred?.isActive && isRefundSource(preferred) ? preferred.id : '';
  const [amount, setAmount] = React.useState(source.max);
  const today = useToday();
  const [date, setDate] = React.useState(today < source.date ? source.date : today);
  const [chosenFrom, setChosenFrom] = React.useState<string | null>(null);
  const fromAccountId = chosenFrom ?? defaultFrom;
  const [method, setMethod] = React.useState<PaymentMethod>(initialMethod);
  const [reference, setReference] = React.useState('');
  const [errors, setErrors] = React.useState<FormError[]>([]);
  const idem = React.useRef(idempotencyKey());
  const cur = source.currency;
  const invalid = invalidFields(errors);
  const what = source.type === 'payment' ? 'this payment' : 'this credit note';

  const tooMuch = isValidDecimal(amount) && compareDecimals(amount, source.max) > 0;
  const dirty = amount !== source.max || fromAccountId !== defaultFrom || method !== initialMethod || !!reference.trim();

  const submit = () => {
    if (refund.isPending) return;
    const errs: FormError[] = [];
    if (!isValidDecimal(amount) || compareDecimals(amount, '0') <= 0) errs.push({ message: 'Enter an amount greater than zero.', fieldId: 'refund-amount' });
    else if (tooMuch) errs.push({ message: `You can refund up to ${formatMoney(source.max, cur)} from ${what}.`, fieldId: 'refund-amount' });
    if (!date) errs.push({ message: 'Date is required.', fieldId: 'refund-date' });
    else if (date < source.date) errs.push({ message: `The refund can’t be dated before ${formatDate(source.date)}.`, fieldId: 'refund-date' });
    if (!fromAccountId) errs.push({ message: 'Choose the account the money is paid back from.', fieldId: 'refund-from' });
    setErrors(errs);
    if (errs.length) {
      focusFirstError(errs);
      return;
    }
    refund.mutate(
      { sourceType: source.type, sourceId: source.id, date, amount: amount.trim(), fromAccountId, method, reference: reference.trim() || null, idempotencyKey: idem.current },
      {
        onSuccess: () => {
          toast.success(`Refund recorded · ${formatMoney(amount.trim(), cur)}`);
          onClose();
        },
        onError: (e) => onError(e, 'Could not record refund'),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty && !refund.isPending}
      title="Refund customer"
      description={`Record money you paid back to the customer. Up to ${formatMoney(source.max, cur)} can be refunded from ${what}.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={refund.isPending}>
            Cancel
          </Button>
          <Button type="submit" loading={refund.isPending}>
            Record refund
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount" htmlFor="refund-amount" required error={tooMuch ? `More than the ${formatMoney(source.max, cur)} available.` : null}>
          <MoneyInput id="refund-amount" data-autofocus value={amount} aria-invalid={tooMuch || invalid.has('refund-amount') || undefined} onChange={setAmount} />
        </Field>
        <Field label="Date" htmlFor="refund-date" required>
          <DateInput id="refund-date" value={date} min={source.date} onChange={setDate} aria-invalid={invalid.has('refund-date') || undefined} />
        </Field>
        <Field label="Paid back from" htmlFor="refund-from" required hint="The bank or card account the money left.">
          <AccountPicker
            id="refund-from"
            value={fromAccountId}
            allow={isRefundSource}
            recentKey="refund-from"
            createType={false}
            invalid={invalid.has('refund-from')}
            onChange={(v) => setChosenFrom(v ?? '')}
          />
        </Field>
        <Field label="Method" htmlFor="refund-method">
          <Select id="refund-method" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
            {PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reference" htmlFor="refund-reference" className="sm:col-span-2" hint="Check number, transaction id…">
          <Input id="refund-reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        </Field>
      </div>
      <div className="mt-3">
        <ErrorSummary errors={errors} />
      </div>
    </Dialog>
  );
}
