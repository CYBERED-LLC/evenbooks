import { notFound } from 'next/navigation';
import { env } from '@/server/env';
import { getProcessor } from '@/server/processor';
import { FixtureOnboardForm } from './form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fixture onboarding', robots: { index: false, follow: false } };

/** Stand-in for Stripe's hosted account onboarding (fixture driver only). */
export default async function FixtureOnboardPage({ searchParams }: { searchParams: Promise<{ account?: string; return?: string }> }) {
  const client = getProcessor();
  if (env().isProduction || client.driver !== 'fixture') notFound();
  const { account, return: returnUrl } = await searchParams;
  if (!account || !returnUrl) notFound();
  return (
    <main className="min-h-full bg-stone-100 px-4 py-12">
      <div className="mx-auto max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">Fixture onboarding (not Stripe)</p>
        <h1 className="mt-2 text-xl font-semibold">Set up your Stripe account</h1>
        <p className="mt-1 text-sm text-stone-600">
          Account <span className="font-mono">{account}</span>. In production Stripe collects business details here.
        </p>
        <FixtureOnboardForm accountId={account} returnUrl={returnUrl} />
      </div>
    </main>
  );
}
