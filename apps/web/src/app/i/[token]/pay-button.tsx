'use client';
import * as React from 'react';
import type { PublicOnlinePaymentDto } from '@evenbooks/contracts';
import { formatMoney } from '@/lib/format';

/**
 * Customer-facing Pay button. Opens a hosted checkout for the payable amount
 * (or a partial amount when the company allows it). Nothing here changes the
 * books: the page re-reads the invoice from the server after the redirect.
 */
export function PayButton({ token, currency, options, accentColor }: { accentColor?: string; token: string; currency: string; options: PublicOnlinePaymentDto }) {
  const [amount, setAmount] = React.useState(options.payableAmount);
  const [partial, setPartial] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const payable = Number(options.payableAmount);
  const minimum = Math.min(Number(options.minimumPayment), payable);
  const valid = /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) >= minimum && Number(amount) <= payable;
  const methods = options.methods.map((m) => (m === 'ach' ? 'bank debit (ACH)' : 'card')).join(' or ');

  if (payable <= 0) {
    return (
      <p role="status" className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900 print:hidden">
        A bank transfer for {formatMoney(options.processingAmount, currency)} is processing. It usually clears within a few business days.
      </p>
    );
  }

  const start = async (method: 'card' | 'ach') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/invoices/${encodeURIComponent(token)}/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(partial ? { method, amount } : { method }),
      });
      const data = (await res.json()) as { url?: string; error?: { message?: string } };
      if (!res.ok || !data.url) throw new Error(data.error?.message ?? 'Could not start the payment');
      window.location.assign(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the payment');
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 print:hidden" data-testid="online-payment">
      {options.allowPartial && (
        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input type="checkbox" className="size-4 rounded border-stone-300" checked={partial} onChange={(e) => setPartial(e.target.checked)} />
          Pay a different amount
        </label>
      )}
      {partial && (
        <div className="mt-2">
          <label htmlFor="pay-amount" className="block text-xs font-medium text-stone-600">
            Amount to pay now ({formatMoney(String(minimum), currency)} to {formatMoney(options.payableAmount, currency)})
          </label>
          <input
            id="pay-amount"
            inputMode="decimal"
            className="mt-1 h-10 w-40 rounded-md border border-stone-300 px-3 text-right tabular"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!valid}
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {options.methods.includes('card') && (
          <button
            type="button"
            style={{ backgroundColor: accentColor }}
            onClick={() => start('card')}
            disabled={busy || (partial && !valid)}
            className="inline-flex h-11 items-center justify-center rounded-md bg-brand-600 px-5 text-base font-medium text-white shadow-sm hover:bg-brand-700 disabled:opacity-60"
            data-testid="pay-now"
          >
            {busy ? 'Opening secure checkout…' : `Pay ${formatMoney(partial && valid ? amount : options.payableAmount, currency)} by card`}
          </button>
        )}
        {options.methods.includes('ach') && (
          <button
            type="button"
            style={{ borderColor: accentColor, color: accentColor }}
            onClick={() => start('ach')}
            disabled={busy || (partial && !valid)}
            className="inline-flex h-11 items-center justify-center rounded-md border border-brand-600 px-5 text-base font-medium text-brand-700 shadow-sm hover:bg-brand-50 disabled:opacity-60"
            data-testid="pay-now-ach"
          >
            {busy ? 'Opening secure checkout…' : `Pay ${formatMoney(partial && valid ? amount : options.payableAmount, currency)} from your bank account`}
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-stone-500">Secure checkout by Stripe. Pay by {methods}.</p>
      {Number(options.processingAmount) > 0 && (
        <p role="status" className="mt-2 text-xs text-blue-800">
          {formatMoney(options.processingAmount, currency)} is already processing as a bank transfer.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
