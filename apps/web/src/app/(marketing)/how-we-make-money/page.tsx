import type { Metadata } from 'next';
import Link from 'next/link';
import { FeeCalculator } from '@/components/marketing/fee-calculator';
import { COMMITMENTS, FEE_FACTS } from '@/lib/marketing-content';

export const metadata: Metadata = { title: 'How we make money', description: 'A plain accounting of Evenbooks’ revenue: the paid plan and a share of free-plan payment fees. Nothing else.' };

export default function HowWeMakeMoneyPage() {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">How we make money</h1>
      <p className="mt-4 text-lg text-stone-600">A bookkeeping company should be able to account for itself. Evenbooks has two sources of revenue and no others.</p>

      <section className="mt-12" aria-labelledby="r1">
        <h2 id="r1" className="font-display text-2xl font-semibold text-stone-900">
          1. The paid plan
        </h2>
        <p className="mt-3 text-stone-700">
          {FEE_FACTS.paidMonthly} a month, or {FEE_FACTS.paidYearly} a year, per company. It removes the payment-fee share below and lets up to 20 people work in one company. Nothing else changes: the free plan has every feature.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="r2">
        <h2 id="r2" className="font-display text-2xl font-semibold text-stone-900">
          2. A share of online payments on the free plan
        </h2>
        <p className="mt-3 text-stone-700">
          When a customer pays a free-plan invoice online, the business pays one all-in rate: {FEE_FACTS.freeCardPercent} on cards, {FEE_FACTS.freeAchPercent} on bank debits. Stripe takes its published fee ({FEE_FACTS.stripeCard} on cards, {FEE_FACTS.stripeAch} on bank debits) out of that rate, and Evenbooks keeps what is left. If Stripe’s fee alone exceeds the rate, we keep nothing. On the paid plan we keep nothing, ever.
        </p>
        <FeeCalculator className="mt-6" defaultAmount="500" />
      </section>

      <section className="mt-10" aria-labelledby="r3">
        <h2 id="r3" className="font-display text-2xl font-semibold text-stone-900">
          What we do not do
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-stone-700">
          <li>No advertising, no “partner offers”, no selling or sharing of your financial data.</li>
          <li>No feature tiers. Reports, bank feeds, invoicing and payments are in the free plan.</li>
          <li>No markup on things others charge for. {FEE_FACTS.simplefinNote}</li>
          <li>No investors to satisfy. Evenbooks is paid for by the two lines above.</li>
        </ul>
      </section>

      <section className="mt-12 rounded-lg border border-stone-200 bg-white p-6" aria-labelledby="c">
        <h2 id="c" className="font-display text-2xl font-semibold text-stone-900">
          What we commit to
        </h2>
        <dl className="mt-4 space-y-4">
          {COMMITMENTS.map((c) => (
            <div key={c.title}>
              <dt className="font-medium text-stone-900">{c.title}</dt>
              <dd className="mt-1 text-stone-600">{c.text}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-sm text-stone-500">
          Details on the license and self-hosting: <Link href="/source-available" className="font-medium text-brand-700 underline-offset-4 hover:underline">Source-available</Link>. Prices: <Link href="/pricing" className="font-medium text-brand-700 underline-offset-4 hover:underline">Pricing</Link>.
        </p>
      </section>
    </article>
  );
}
