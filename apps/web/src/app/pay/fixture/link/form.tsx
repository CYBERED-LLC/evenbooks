'use client';
import * as React from 'react';

export function FixtureLinkForm({ state, redirectUri }: { state: string; redirectUri: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [balance, setBalance] = React.useState('0.00');
  const back = (params: Record<string, string>) => {
    const u = new URL(redirectUri);
    u.searchParams.set('state', state);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    window.location.assign(u.toString());
  };
  const authorize = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/dev/processor/authorize-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ balance, displayName: 'Existing Stripe business' }) });
      const data = (await res.json()) as { code?: string; error?: { message: string } };
      if (!res.ok || !data.code) throw new Error(data.error?.message ?? 'Failed');
      back({ code: data.code, scope: 'read_write' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="mt-6 space-y-3">
      <label className="block text-sm text-stone-700">
        Balance already in the account
        <input className="mt-1 h-10 w-full rounded-md border border-stone-300 px-3" data-testid="fixture-link-balance" inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} />
      </label>
      <button type="button" disabled={busy} className="h-11 w-full rounded-md bg-stone-900 text-base font-medium text-white disabled:opacity-60" data-testid="fixture-authorize-link" onClick={authorize}>
        Sign in and connect an existing account
      </button>
      <button type="button" disabled={busy} className="h-10 w-full rounded-md border border-stone-300 text-sm text-stone-700 disabled:opacity-60" data-testid="fixture-deny-link" onClick={() => back({ error: 'access_denied', error_description: 'The user denied your request' })}>
        Decline
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
