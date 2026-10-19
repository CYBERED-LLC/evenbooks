import type { ReactNode } from 'react';
import Link from 'next/link';
import { BarChart3, CreditCard, FileText, Landmark, Scale, Users } from 'lucide-react';
import { LinkButton } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { COMMITMENTS, FEATURES, FEE_FACTS, PLANS, SOURCE, TAGLINES } from '@/lib/marketing-content';
import { ClosingMark } from './closing-mark';
import { GetPaid } from './get-paid';
import { InboxDemo } from './inbox-demo';
import { MonthScrubber } from './month-scrubber';
import type { DemoMonth } from './demo-month';

const featureIcons: Record<string, typeof Scale> = {
  ledger: Scale,
  invoicing: FileText,
  payments: CreditCard,
  banking: Landmark,
  reports: BarChart3,
  team: Users,
};

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="text-stone-500">{term}</dt>
      <dd className="tabular text-right font-medium text-stone-900">{children}</dd>
    </div>
  );
}

function SectionHead({ step, title, children }: { step: string; title: string; children: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <p className="flex items-center gap-3 text-xs font-semibold tracking-[0.16em] text-brand-700 uppercase">
        <span aria-hidden className="flex flex-col gap-[3px]">
          <span className="block h-[3px] w-4 rounded-full bg-brand-600" />
          <span className="block h-[3px] w-4 rounded-full bg-brand-600" />
        </span>
        {step}
      </p>
      <h2 className="mt-3 font-display text-[clamp(1.9rem,5vw,3rem)] leading-[1.06] font-semibold tracking-[-0.02em] text-stone-900">{title}</h2>
      <div className="mt-4 text-lg leading-8 text-stone-600">{children}</div>
    </div>
  );
}

/**
 * The public homepage (docs/brand-bible.md §7): a working corner of the
 * product, then getting paid, a month of books, the plans, the terms.
 */
export default function HomePage({ month }: { month: DemoMonth }) {
  return (
    <>
      <style>{css}</style>

      {/* Hero: a working corner of the product, not a picture of it. */}
      <section className="relative overflow-x-clip border-b border-stone-200">
        <div aria-hidden className="ve-rule pointer-events-none absolute inset-0" />
        <div className="relative mx-auto w-full max-w-6xl px-4 pt-12 pb-16 sm:px-6 sm:pt-20 sm:pb-24">
          <div className="ve-rise grid gap-6 lg:grid-cols-[1.15fr_1fr] lg:items-end lg:gap-14">
            <div className="min-w-0">
              <h1 className="font-display text-[clamp(2.6rem,7.5vw,5rem)] leading-[1] font-semibold tracking-[-0.03em] text-balance text-stone-900">
                Go on, do the books.
              </h1>
            </div>
            <div className="min-w-0">
              <p className="text-lg leading-8 text-stone-600">
                This is the real product, not a screenshot. Approve five transactions and watch each one become a journal entry. It takes about
                twenty seconds.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <LinkButton href="/sign-up" size="lg">
                  Start for free
                </LinkButton>
                <LinkButton href="/sign-in" variant="secondary" size="lg">
                  Sign in
                </LinkButton>
              </div>
            </div>
          </div>
          <div className="ve-rise ve-d2 mt-10 sm:mt-14">
            <InboxDemo month={month} />
          </div>
        </div>
      </section>

      <section className="border-b border-stone-200 bg-white py-16 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHead step="Get paid" title="Your customer pays. The books are already done.">
            Every invoice comes with a pay link. Your customer pays by card or bank transfer, right from the email. The payment, the fee and
            the payout all land in the right accounts on their own.
          </SectionHead>
          <div className="mt-10 sm:mt-12">
            <GetPaid month={month} />
          </div>
        </div>
      </section>

      <section className="border-b border-stone-200 py-16 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHead step="A month" title={`${month.name} at Juniper Studio, in thirty seconds.`}>
            Two invoices, two payments, a few bills and a reconciliation. Press play or drag through the month to watch money move from what
            you’re owed, to Stripe, to your bank. Every fee lands where it belongs.
          </SectionHead>
          <div className="mt-10 sm:mt-12">
            <MonthScrubber month={month} />
          </div>
          <ul className="mt-14 grid gap-px overflow-hidden rounded-lg border border-stone-200 bg-stone-200 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => {
              const Icon = featureIcons[f.id] ?? Scale;
              return (
                <li key={f.id} className="bg-white p-5">
                  <Icon className="size-5 text-brand-600" aria-hidden />
                  <p className="mt-3 font-display text-lg font-semibold text-stone-900">{f.title}</p>
                  <p className="mt-1.5 text-sm leading-6 text-stone-600">{f.summary}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="border-b border-stone-200 bg-stone-100 py-16 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHead step="Pricing" title="Two plans, priced right here.">
            Free costs $0 a month. We earn a share when your customers pay online. Paid is {FEE_FACTS.paidMonthly} a month per company, not per
            person, and we take nothing from your payments.
          </SectionHead>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {PLANS.map((p) => (
              <div key={p.id} className="flex flex-col rounded-lg border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="font-display text-xl font-semibold text-stone-900">{p.name}</h3>
                  {p.id === 'free' ? <Badge tone="green">No card needed</Badge> : <Badge tone="neutral">For a team</Badge>}
                </div>
                <p className="mt-4 flex items-baseline gap-2">
                  <span className="font-display text-4xl font-semibold text-stone-900">
                    <span className="tabular">{p.price}</span>
                  </span>
                  <span className="text-sm text-stone-500">{p.cadence}</span>
                </p>
                <p className="mt-1 h-5 text-sm text-stone-500">
                  <span className="tabular">{p.altPrice ?? ''}</span>
                </p>
                <dl className="mt-5 divide-y divide-stone-100 border-y border-stone-200 text-sm">
                  <Fact term="People">{p.members}</Fact>
                  <Fact term="Card payments">{p.cardFee}</Fact>
                  <Fact term="Bank transfers">{p.achFee}</Fact>
                </dl>
                <ul className="mt-5 flex-1 space-y-2.5 text-sm text-stone-700">
                  {p.bullets.map((b) => (
                    <li key={b} className="flex gap-2.5">
                      <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-brand-600" />
                      <span className="leading-relaxed">{b}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  {p.id === 'free' ? (
                    <LinkButton href="/sign-up" size="lg" className="w-full">
                      Start for free
                    </LinkButton>
                  ) : (
                    <LinkButton href="/pricing" variant="secondary" size="lg" className="w-full">
                      See the full comparison
                    </LinkButton>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-3xl text-sm leading-6 text-stone-500">
            {FEE_FACTS.simplefinNote}{' '}
            <Link href="/how-we-make-money" className="text-brand-700 underline underline-offset-4 hover:text-brand-800">
              See exactly how the fees work
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="py-16 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHead step="And the terms" title="Even books. Even terms.">
            Four promises, and the {SOURCE.licence} behind them.
          </SectionHead>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2">
            {COMMITMENTS.map((c) => (
              <li key={c.title} tabIndex={0} className="ve-even group rounded-lg border border-stone-200 bg-white p-6 outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                <span aria-hidden className="flex w-12 flex-col gap-1.5">
                  <span className="ve-b1 block h-1.5 rounded-full bg-stone-300" />
                  <span className="ve-b2 block h-1.5 rounded-full bg-stone-300" />
                </span>
                <p className="mt-5 font-display text-xl font-semibold tracking-tight text-stone-900">{c.title}</p>
                <p className="mt-2 text-base leading-7 text-stone-600">{c.text}</p>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-sm text-stone-500">
            <Link href="/source-available" className="text-brand-700 underline underline-offset-4 hover:text-brand-800">
              Read the license terms
            </Link>
          </p>
        </div>
      </section>

      <ClosingMark headline="Make it even.">{TAGLINES.mission}</ClosingMark>
    </>
  );
}

const css = `
.ve-rule {
  background-image: repeating-linear-gradient(to bottom, transparent 0, transparent 31px, color-mix(in oklab, var(--color-stone-300) 45%, transparent) 31px, color-mix(in oklab, var(--color-stone-300) 45%, transparent) 32px);
  mask-image: linear-gradient(to bottom, black, transparent 70%);
}
.ve-range { accent-color: var(--color-brand-600); height: 1.5rem; }
.ve-stage {
  background:
    radial-gradient(60% 80% at 15% 0%, color-mix(in oklab, var(--color-brand-500) 12%, transparent), transparent 70%),
    radial-gradient(50% 70% at 100% 100%, color-mix(in oklab, var(--color-brand-500) 9%, transparent), transparent 70%),
    var(--color-stone-100);
}
.ve-wire { background-image: repeating-linear-gradient(to bottom, var(--color-stone-400) 0 6px, transparent 6px 12px); }
.ve-token { left: 50%; top: 0; translate: -50% -50%; opacity: 0; }
.ve-reveal, .ve-screen, .ve-swap { transition: opacity 450ms ease, translate 450ms cubic-bezier(0.22, 0.7, 0.2, 1); }
@media (min-width: 1024px) {
  .ve-wire { background-image: repeating-linear-gradient(to right, var(--color-stone-400) 0 6px, transparent 6px 12px); }
  .ve-token { top: 50%; left: 0; }
}
.ve-b1, .ve-b2 { transition: transform 420ms cubic-bezier(0.22, 0.7, 0.2, 1), background-color 420ms; }
.ve-b1 { transform: translateX(-18%); }
.ve-b2 { transform: translateX(28%); }
.ve-even:hover .ve-b1, .ve-even:hover .ve-b2, .ve-even:focus-visible .ve-b1, .ve-even:focus-visible .ve-b2 { transform: none; background-color: var(--color-brand-600); }
@media (hover: none) {
  .ve-b1, .ve-b2 { transform: none; background-color: var(--color-brand-600); }
}
@media (prefers-reduced-motion: no-preference) {
  .ve-bar { transition: width 520ms cubic-bezier(0.22, 0.7, 0.2, 1), background-color 300ms; }
  .ve-slash { transition: scale 320ms cubic-bezier(0.3, 1.5, 0.5, 1), opacity 200ms; }
  .ve-glide { transition: transform 900ms cubic-bezier(0.22, 0.7, 0.2, 1); }
  .ve-dot { transition: left 300ms ease-out, top 300ms ease-out; }
  .ve-approve:active { scale: 0.96; }
  .ve-rise { animation: ve-rise 600ms cubic-bezier(0.22, 0.7, 0.2, 1) both; }
  .ve-d2 { animation-delay: 140ms; }
  .ve-pop { animation: ve-pop 320ms cubic-bezier(0.22, 0.7, 0.2, 1) both; }
  .ve-entry { animation: ve-pop 280ms cubic-bezier(0.22, 0.7, 0.2, 1) both; }
  .ve-leg { animation: ve-leg 300ms cubic-bezier(0.22, 0.7, 0.2, 1) both; }
  .ve-leg-late { animation-delay: 520ms; }
  .ve-wire { animation: ve-flow 900ms linear infinite; }
  .ve-token-out { animation: ve-down 1000ms cubic-bezier(0.5, 0, 0.3, 1) 150ms both; }
  .ve-token-back { animation: ve-up 1000ms cubic-bezier(0.5, 0, 0.3, 1) 150ms both; }
  .ve-cursor { animation: ve-cursor 1700ms cubic-bezier(0.22, 0.7, 0.2, 1) 200ms both; }
  .ve-press { animation: ve-press 280ms ease 1500ms both; }
  .ve-tap { animation: ve-tap 650ms ease-out 2300ms both; }
  .ve-check { animation: ve-check 480ms cubic-bezier(0.3, 1.4, 0.5, 1) both; }
  .ve-progress { animation: ve-progress linear both; }
  @media (min-width: 1024px) {
    .ve-wire { animation-name: ve-flow-x; }
    .ve-token-out { animation-name: ve-right; }
    .ve-token-back { animation-name: ve-left; }
  }
  @keyframes ve-flow { to { background-position: 0 12px; } }
  @keyframes ve-flow-x { to { background-position: 12px 0; } }
  @keyframes ve-down { 0% { top: 0; opacity: 0; } 15%, 85% { opacity: 1; } 100% { top: 100%; opacity: 0; } }
  @keyframes ve-up { 0% { top: 100%; opacity: 0; } 15%, 85% { opacity: 1; } 100% { top: 0; opacity: 0; } }
  @keyframes ve-right { 0% { left: 0; opacity: 0; } 15%, 85% { opacity: 1; } 100% { left: 100%; opacity: 0; } }
  @keyframes ve-left { 0% { left: 100%; opacity: 0; } 15%, 85% { opacity: 1; } 100% { left: 0; opacity: 0; } }
  @keyframes ve-cursor { 0% { opacity: 0; transform: translate(4rem, 2.5rem); } 70% { opacity: 1; transform: none; } 80% { transform: scale(0.85); } 100% { opacity: 1; transform: none; } }
  @keyframes ve-press { 50% { scale: 0.95; } }
  @keyframes ve-tap { from { scale: 0; opacity: 0.7; } to { scale: 6; opacity: 0; } }
  @keyframes ve-check { from { scale: 0.5; opacity: 0; } to { scale: 1; opacity: 1; } }
  @keyframes ve-progress { from { scale: 0 1; } to { scale: 1 1; } }
  @keyframes ve-rise { from { opacity: 0; transform: translateY(0.75rem); } to { opacity: 1; transform: none; } }
  @keyframes ve-pop { from { opacity: 0; transform: translateY(0.25rem) scale(0.985); } to { opacity: 1; transform: none; } }
  @keyframes ve-leg { from { opacity: 0; transform: translateX(-0.5rem); } to { opacity: 1; transform: none; } }
}
`;
