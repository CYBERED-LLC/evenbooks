'use client';
import * as React from 'react';
import { Money } from '@evenbooks/domain';
import { DEFAULT_PLATFORM_FEE, computePlatformFee, estimateProcessorFee, type OnlinePaymentMethod } from '@evenbooks/domain';
import { Input, Label } from '@/components/ui/input';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Shows exactly what a business pays to get paid online, using the same
 * function the product uses (computePlatformFee), so the marketing math can
 * never drift from the real fee.
 */
export function FeeCalculator({ className, defaultAmount = '1000' }: { className?: string; defaultAmount?: string }) {
  const [raw, setRaw] = React.useState(defaultAmount);
  const amount = React.useMemo(() => {
    const cleaned = raw.replace(/[^0-9.]/g, '');
    try {
      const m = Money.of(cleaned === '' ? '0' : cleaned, 'USD');
      return m.isPositive() ? m : Money.zero('USD');
    } catch {
      return Money.zero('USD');
    }
  }, [raw]);

  const rows = (['card', 'ach'] as OnlinePaymentMethod[]).map((method) => {
    const stripe = estimateProcessorFee(amount, method, DEFAULT_PLATFORM_FEE.schedule);
    const ours = computePlatformFee(amount, 'free', method, DEFAULT_PLATFORM_FEE);
    return { method, stripe, ours, freeTotal: stripe.add(ours), paidTotal: stripe };
  });
  const usd = (m: Money) => formatMoney(m.toString(), 'USD');

  return (
    <div className={cn('rounded-lg border border-stone-200 bg-white p-5 shadow-sm', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="sm:w-56">
          <Label htmlFor="fee-amount">Invoice amount</Label>
          <div className="relative mt-1">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-stone-500">$</span>
            <Input id="fee-amount" inputMode="decimal" value={raw} onChange={(e) => setRaw(e.target.value)} className="pl-7 tabular" aria-describedby="fee-note" />
          </div>
        </div>
        <p id="fee-note" className="text-sm text-stone-600">
          Computed with the product&apos;s own fee function. Stripe&apos;s fees are its published US rates.
        </p>
      </div>
      {/* Phones: one block per method. Larger screens: the comparison table. */}
      <ul className="mt-4 space-y-3 sm:hidden">
        {rows.map((r) => (
          <li key={r.method} className="rounded-md border border-stone-200 bg-stone-50 p-3 text-sm">
            <p className="font-medium text-stone-800">{r.method === 'card' ? 'Card' : 'Bank transfer'}</p>
            <dl className="mt-2 grid grid-cols-2 gap-y-1">
              <dt className="text-stone-500">Stripe keeps</dt>
              <dd className="tabular text-right text-stone-700">{usd(r.stripe)}</dd>
              <dt className="text-stone-500">Evenbooks keeps</dt>
              <dd className="tabular text-right text-stone-700">{usd(r.ours)}</dd>
              <dt className="font-medium text-stone-800">Free plan, you pay</dt>
              <dd className="tabular text-right font-semibold text-stone-900">
                {usd(r.freeTotal)} <span className="text-xs font-normal text-stone-500">({r.method === 'card' ? '5%' : '1%'})</span>
              </dd>
              <dt className="font-medium text-stone-800">Paid plan, you pay</dt>
              <dd className="tabular text-right font-semibold text-stone-900">{usd(r.paidTotal)}</dd>
            </dl>
          </li>
        ))}
      </ul>
      <div className="mt-4 hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead className="text-left text-xs font-semibold uppercase tracking-wide text-stone-500">
            <tr>
              <th className="py-2 pr-3">Paid by</th>
              <th className="py-2 pr-3 text-right">Stripe keeps</th>
              <th className="py-2 pr-3 text-right">Evenbooks keeps</th>
              <th className="py-2 pr-3 text-right">Free plan, you pay</th>
              <th className="py-2 text-right">Paid plan, you pay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((r) => (
              <tr key={r.method}>
                <td className="py-2 pr-3 font-medium text-stone-800">{r.method === 'card' ? 'Card' : 'Bank transfer'}</td>
                <td className="tabular py-2 pr-3 text-right text-stone-700">{usd(r.stripe)}</td>
                <td className="tabular py-2 pr-3 text-right text-stone-700">{usd(r.ours)}</td>
                <td className="tabular py-2 pr-3 text-right font-semibold text-stone-900">
                  {usd(r.freeTotal)} <span className="text-xs font-normal text-stone-500">({r.method === 'card' ? '5%' : '1%'})</span>
                </td>
                <td className="tabular py-2 text-right font-semibold text-stone-900">{usd(r.paidTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-stone-500">
        On the free plan the rate is all-in: Stripe&apos;s fee is included in the 5% or 1%, not added on top. On very small charges Stripe&apos;s fixed 30¢ can exceed the rate, and then Evenbooks keeps nothing. Non-standard Stripe fees (international cards, currency conversion, disputes) are passed through.
      </p>
    </div>
  );
}
