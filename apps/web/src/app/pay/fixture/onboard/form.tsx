'use client';
import * as React from 'react';

export function FixtureOnboardForm({ accountId, returnUrl }: { accountId: string; returnUrl: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const finish = async (action: 'complete-onboarding' | 'restrict-account') => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dev/processor/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId }) });
      if (!res.ok) throw new Error(((await res.json()) as { error?: { message: string } }).error?.message ?? 'Failed');
      window.location.assign(returnUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="mt-6 space-y-3">
      <button type="button" disabled={busy} className="h-11 w-full rounded-md bg-stone-900 text-base font-medium text-white disabled:opacity-60" data-testid="fixture-finish-onboarding" onClick={() => finish('complete-onboarding')}>
        Finish onboarding (enable charges and payouts)
      </button>
      <button type="button" disabled={busy} className="h-10 w-full rounded-md border border-stone-300 text-sm text-stone-700 disabled:opacity-60" onClick={() => finish('restrict-account')}>
        Leave requirements unmet (restricted)
      </button>
      <a href={returnUrl} className="block text-center text-sm text-stone-600 underline">
        Return without finishing
      </a>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
