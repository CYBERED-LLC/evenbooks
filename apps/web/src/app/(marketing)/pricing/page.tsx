import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { LinkButton } from '@/components/ui/button';
import { FeeCalculator } from '@/components/marketing/fee-calculator';
import { FAQ, FEE_FACTS, PLANS } from '@/lib/marketing-content';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Pricing', description: 'Free for one person. $15 a month per company for a team. Payment fees published and computed in the open.' };

export default function PricingPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6">
      <header className="max-w-2xl">
        <h1 className="font-display text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">One price. Written down.</h1>
        <p className="mt-4 text-lg text-stone-600">Free for one person, forever. {FEE_FACTS.paidMonthly} a month per company when you want a team. The fee math below is computed by the same code the product runs.</p>
      </header>

      <div className="mt-12 grid gap-6 lg:grid-cols-2">
        {PLANS.map((p) => (
          <section key={p.id} aria-labelledby={`plan-${p.id}`} className={cn('rounded-lg border bg-white p-6 shadow-sm', p.id === 'paid' ? 'border-brand-500 ring-2 ring-brand-200' : 'border-stone-200')}>
            <div className="flex items-baseline justify-between gap-4">
              <h2 id={`plan-${p.id}`} className="font-display text-2xl font-semibold text-stone-900">
                {p.name}
              </h2>
              <p className="text-right">
                <span className="tabular font-display text-4xl font-semibold text-stone-900">{p.price}</span>
                <span className="block text-sm text-stone-500">{p.cadence}</span>
                {p.altPrice && <span className="block text-sm text-stone-500">{p.altPrice}</span>}
              </p>
            </div>
            <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
              <Fact k="Team" v={p.members} />
              <Fact k="Cards" v={p.cardFee} />
              <Fact k="Bank transfers" v={p.achFee} />
            </dl>
            <ul className="mt-6 space-y-2 text-sm text-stone-700">
              {p.bullets.map((b) => (
                <li key={b} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
                  {b}
                </li>
              ))}
            </ul>
            <LinkButton href="/sign-up" variant={p.id === 'paid' ? 'primary' : 'secondary'} className="mt-8 w-full">
              {p.id === 'paid' ? 'Start for free, upgrade when you add someone' : 'Start for free'}
            </LinkButton>
          </section>
        ))}
      </div>

      <section className="mt-16" aria-labelledby="fees">
        <h2 id="fees" className="font-display text-2xl font-semibold text-stone-900">
          What getting paid online costs
        </h2>
        <p className="mt-2 max-w-2xl text-stone-600">You connect your own Stripe account and Stripe pays you directly. On the free plan the rate is all-in. On the paid plan you pay Stripe and nothing else.</p>
        <FeeCalculator className="mt-6" />
        <p className="mt-3 text-sm text-stone-500">{FEE_FACTS.simplefinNote}</p>
      </section>

      <section className="mt-16 max-w-3xl" aria-labelledby="faq">
        <h2 id="faq" className="font-display text-2xl font-semibold text-stone-900">
          Questions
        </h2>
        <dl className="mt-6 divide-y divide-stone-200">
          {FAQ.map((f) => (
            <div key={f.q} className="py-4">
              <dt className="font-medium text-stone-900">{f.q}</dt>
              <dd className="mt-1 text-stone-600">{f.a}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 text-sm text-stone-500">
          The full accounting of where the money goes is on <Link href="/how-we-make-money" className="font-medium text-brand-700 underline-offset-4 hover:underline">How we make money</Link>.
        </p>
      </section>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-stone-500">{k}</dt>
      <dd className="mt-0.5 font-medium text-stone-800">{v}</dd>
    </div>
  );
}
