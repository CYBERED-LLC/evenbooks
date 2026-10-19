import { notFound } from 'next/navigation';
import { env } from '@/server/env';
import { getProcessor } from '@/server/processor';
import { FixtureLinkForm } from './form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fixture account linking', robots: { index: false, follow: false } };

/** Stand-in for Stripe's Connect OAuth sign-in and authorization page (fixture driver only). */
export default async function FixtureLinkPage({ searchParams }: { searchParams: Promise<{ state?: string; redirect_uri?: string }> }) {
  const client = getProcessor();
  if (env().isProduction || client.driver !== 'fixture') notFound();
  const { state, redirect_uri: redirectUri } = await searchParams;
  if (!state || !redirectUri) notFound();
  return (
    <main className="min-h-full bg-stone-100 px-4 py-12">
      <div className="mx-auto max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">Fixture sign-in (not Stripe)</p>
        <h1 className="mt-2 text-xl font-semibold">Connect your Stripe account to Evenbooks</h1>
        <p className="mt-1 text-sm text-stone-600">In production you sign in to Stripe here and approve access for Evenbooks.</p>
        <FixtureLinkForm state={state} redirectUri={redirectUri} />
      </div>
    </main>
  );
}
