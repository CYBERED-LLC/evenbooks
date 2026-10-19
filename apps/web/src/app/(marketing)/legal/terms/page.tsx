import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of service' };

/** Plain-language draft. To be reviewed by counsel before launch. */
export default function TermsPage() {
  return (
    <article className="prose-stone mx-auto w-full max-w-3xl px-4 py-16 text-stone-700 sm:px-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight text-stone-900">Terms of service</h1>
      <p className="mt-2 text-sm text-stone-500">Draft, effective at launch. Written in plain language on purpose.</p>
      <Section title="Who we are">Evenbooks is operated by CYBERED LLC, a Wyoming limited liability company (“we”). These terms cover the hosted service at evenbooks.org. Self-hosted copies are governed by the Elastic License 2.0 instead.</Section>
      <Section title="Your account and your company">You need an account to use the service, and each set of books belongs to a company you create. You are responsible for who you invite and for keeping your sign-in secure. You must be at least 18 and use the service for a business you are entitled to keep books for.</Section>
      <Section title="What the service is, and is not">Evenbooks is bookkeeping software. It records what you and your connected services tell it and computes reports from those records. It is not accounting, tax or legal advice, and it does not file anything on your behalf. You remain responsible for the accuracy of your books and for your filings.</Section>
      <Section title="Payments through Stripe">Online payments are processed by Stripe under your own Stripe account and Stripe’s agreements. Evenbooks charges the platform fee described on the pricing page, deducted by Stripe from each payment. Chargebacks, disputes and refunds are between you, your customer and Stripe.</Section>
      <Section title="Fees and plans">The free plan is free. The paid plan is billed per company at the price shown when you subscribe. We will give at least 30 days’ notice by email before any price change takes effect for you.</Section>
      <Section title="Your data">Your books are yours. You can export every report at any time and delete your company. We use your data only to run the service for you; see the privacy page. We keep encrypted backups so we can restore the service after a failure.</Section>
      <Section title="Availability and liability">We aim to keep the service available and will tell you about incidents. The service is provided as is, and to the extent the law allows, our total liability to you is limited to the fees you paid us in the twelve months before the claim.</Section>
      <Section title="Ending things">You can leave at any time. We can suspend an account that breaks these terms or the law, and we will say why. If we ever discontinue the hosted service, we will give at least 90 days’ notice, keep exports available for that period, and release the code under Apache 2.0 as promised.</Section>
      <Section title="Contact">hello@evenbooks.org</Section>
    </article>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="font-display text-xl font-semibold text-stone-900">{title}</h2>
      <p className="mt-2 leading-relaxed">{children}</p>
    </section>
  );
}
