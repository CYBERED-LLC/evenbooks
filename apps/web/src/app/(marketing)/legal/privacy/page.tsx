import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy' };

/** Plain-language draft. To be reviewed by counsel before launch. */
export default function PrivacyPage() {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-16 text-stone-700 sm:px-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight text-stone-900">Privacy</h1>
      <p className="mt-2 text-sm text-stone-500">Draft, effective at launch.</p>
      <Section title="Who we are">Evenbooks is operated by CYBERED LLC, a Wyoming limited liability company (“we”). We are responsible for the personal information described here when you use the hosted service at evenbooks.org.</Section>
      <Section title="What we collect">Your name and email address (through our sign-in provider, Clerk), the books you keep (companies, contacts, invoices, transactions, attachments), and the technical logs needed to run the service. If you connect a bank through SimpleFIN Bridge we store only the encrypted access URL you give us. Card details never touch our servers; Stripe handles them.</Section>
      <Section title="What we do with it">We run the service for you. We do not sell it, share it for advertising, or train models on it. Emails we send on your behalf (invoices, receipts) go through Amazon SES with your reply-to address.</Section>
      <Section title="Who else sees it">Our infrastructure providers, each under their own agreements: Railway (hosting and database, United States), Clerk (sign-in), Stripe (payments), Amazon Web Services (email), and SimpleFIN (bank feeds, only if you connect one). People you invite to your company see that company’s books.</Section>
      <Section title="How long we keep it">For as long as your company exists in Evenbooks, plus the time needed to expire backups. Delete your company and it is gone from live systems immediately and from backups within 35 days.</Section>
      <Section title="Cookies">A session cookie from Clerk to keep you signed in, and an appearance cookie that remembers light or dark mode. No advertising or analytics cookies.</Section>
      <Section title="Your rights">Export your data any time from the reports. Ask us to delete your account and we will. Write to hello@evenbooks.org for anything else.</Section>
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
