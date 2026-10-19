'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';

type Outcome = { outcomes: { id: string; type: string; status: string; error?: string }[]; successUrl: string | null; cancelUrl: string | null };

export function FixtureCheckoutForm({
  sessionId,
  status,
  paymentStatus,
  intentStatus,
  methods,
  successUrl,
  cancelUrl,
}: {
  sessionId: string;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid';
  intentStatus: string;
  methods: ('card' | 'ach')[];
  successUrl: string;
  cancelUrl: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<Outcome['outcomes']>([]);

  const call = async (action: string, body: Record<string, unknown>, then?: (o: Outcome) => void) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dev/processor/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body }) });
      const data = (await res.json()) as Outcome & { error?: { message: string } };
      if (!res.ok) throw new Error(data.error?.message ?? 'Fixture action failed');
      setLog(data.outcomes);
      then?.(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (status === 'expired') return <p className="mt-4 text-sm text-red-700">This checkout session has expired.</p>;

  return (
    <div className="mt-6 space-y-3">
      {status === 'open' && (
        <>
          {methods.includes('card') && (
            <button type="button" disabled={busy} className="h-11 w-full rounded-md bg-stone-900 text-base font-medium text-white disabled:opacity-60" data-testid="fixture-pay-card" onClick={() => call('complete-checkout', { method: 'card', payerEmail: 'payer@example.test' }, (o) => window.location.assign(o.successUrl ?? successUrl))}>
              Pay with card (settles now)
            </button>
          )}
          {methods.includes('ach') && (
            <button type="button" disabled={busy} className="h-11 w-full rounded-md border border-stone-900 text-base font-medium text-stone-900 disabled:opacity-60" data-testid="fixture-pay-ach" onClick={() => call('complete-checkout', { method: 'ach', payerEmail: 'payer@example.test' }, (o) => window.location.assign(o.successUrl ?? successUrl))}>
              Pay by bank debit (settles later)
            </button>
          )}
          <a href={cancelUrl} className="block text-center text-sm text-stone-600 underline">
            Cancel and go back
          </a>
        </>
      )}
      {status === 'complete' && paymentStatus === 'paid' && <p className="text-sm text-emerald-700">Paid. The business has been notified.</p>}
      {status === 'complete' && paymentStatus === 'unpaid' && intentStatus === 'processing' && (
        <>
          <p className="text-sm text-blue-800">Bank debit accepted and processing. Simulate the bank’s answer:</p>
          <div className="flex gap-2">
            <button type="button" disabled={busy} className="h-10 flex-1 rounded-md bg-emerald-700 text-sm font-medium text-white disabled:opacity-60" data-testid="fixture-settle-ach" onClick={() => call('settle-ach', { outcome: 'succeeded' }, () => router.refresh())}>
              Debit succeeded
            </button>
            <button type="button" disabled={busy} className="h-10 flex-1 rounded-md bg-red-700 text-sm font-medium text-white disabled:opacity-60" data-testid="fixture-fail-ach" onClick={() => call('settle-ach', { outcome: 'failed' }, () => router.refresh())}>
              Debit failed
            </button>
          </div>
        </>
      )}
      {status === 'complete' && paymentStatus === 'unpaid' && intentStatus !== 'processing' && <p className="text-sm text-red-700">The bank debit failed. The customer can start a new payment from the invoice.</p>}
      {status === 'complete' && (
        <a href={successUrl.replace('checkout=success', 'checkout=return')} className="block text-center text-sm text-stone-600 underline">
          Back to the invoice
        </a>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {log.length > 0 && (
        <ul className="rounded-md bg-stone-50 p-2 font-mono text-xs text-stone-600" aria-label="Webhook outcomes">
          {log.map((o) => (
            <li key={o.id}>
              {o.type} → {o.status}
              {o.error ? `: ${o.error}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
