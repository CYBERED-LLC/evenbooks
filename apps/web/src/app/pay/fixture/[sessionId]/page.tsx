import { notFound } from 'next/navigation';
import type { FixturePaymentProcessor } from '@evenbooks/integrations';
import { env } from '@/server/env';
import { getProcessor } from '@/server/processor';
import { formatMoney } from '@/lib/format';
import { FixtureCheckoutForm } from './form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Fixture checkout', robots: { index: false, follow: false } };

/**
 * Stand-in for Stripe Checkout when PAYMENTS_DRIVER=fixture. Lets a developer
 * or a browser test "pay" and drive ACH settlement. Never served in production.
 */
export default async function FixtureCheckoutPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const client = getProcessor();
  if (env().isProduction || client.driver !== 'fixture') notFound();
  const { sessionId } = await params;
  const fx = client as FixturePaymentProcessor;
  const session = fx.sessions.get(sessionId);
  if (!session) notFound();
  const intent = fx.intents.get(session.paymentIntentId);
  const cur = session.currency;
  const amount = (session.amount / 100).toFixed(2);
  return (
    <main className="min-h-full bg-stone-100 px-4 py-12">
      <div className="mx-auto max-w-md rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-violet-700">Fixture checkout (not Stripe)</p>
        <h1 className="mt-2 text-xl font-semibold">{session.description}</h1>
        <p className="mt-1 text-3xl font-semibold tabular" data-testid="fixture-amount">
          {formatMoney(amount, cur)}
        </p>
        {session.applicationFee > 0 && <p className="mt-1 text-xs text-stone-500">Includes a platform fee of {formatMoney((session.applicationFee / 100).toFixed(2), cur)} charged to the business.</p>}
        <FixtureCheckoutForm sessionId={session.id} status={session.status} paymentStatus={session.paymentStatus} intentStatus={intent?.status ?? 'requires_payment_method'} methods={session.methods} successUrl={session.successUrl} cancelUrl={session.cancelUrl} />
      </div>
    </main>
  );
}
