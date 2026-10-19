import type { Metadata } from 'next';
import Link from 'next/link';
import { SOURCE } from '@/lib/marketing-content';

export const metadata: Metadata = { title: 'Source-available and self-hosting', description: 'Evenbooks is published under the Elastic License 2.0. Read it, run it for your own company, keep it forever.' };

export default function SourceAvailablePage() {
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
      <h1 className="font-display text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl">The source is open to read and run</h1>
      <p className="mt-4 text-lg text-stone-600">Your books should not depend on a company you cannot inspect. The Evenbooks code is published under the {SOURCE.licence}.</p>

      <section className="mt-12" aria-labelledby="what">
        <h2 id="what" className="font-display text-2xl font-semibold text-stone-900">
          What the license allows
        </h2>
        <p className="mt-3 text-stone-700">{SOURCE.licenceSummary} In practice:</p>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-stone-700">
          <li>Run Evenbooks on your own server for your own company, free, forever.</li>
          <li>A bookkeeper may run it for clients they serve directly.</li>
          <li>Read the ledger code, the fee math and the migrations. Audit anything.</li>
          <li>You may not offer it to the public as a hosted or managed service.</li>
        </ul>
        <p className="mt-4 text-stone-700">
          This is <strong>source-available</strong>, not open source by the Open Source Initiative’s definition, and we say so plainly. If the hosted service is ever discontinued, the code is released under Apache 2.0.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="how">
        <h2 id="how" className="font-display text-2xl font-semibold text-stone-900">
          Self-hosting
        </h2>
        <p className="mt-3 text-stone-700">
          Evenbooks is a Next.js application with a PostgreSQL database and a small worker. It needs an identity provider (Clerk), an S3-compatible bucket for PDFs and attachments, and optionally SES for email, SimpleFIN for bank feeds and Stripe for payments. A Docker Compose file and a setup guide ship with the repository. Self-hosting is community supported: we read issues, we do not run your server.
        </p>
        {SOURCE.repoUrl ? (
          <p className="mt-4">
            <a href={SOURCE.repoUrl} className="font-medium text-brand-700 underline-offset-4 hover:underline">
              Repository
            </a>
          </p>
        ) : (
          <p className="mt-4 rounded-md border border-dashed border-stone-300 bg-white px-4 py-3 text-sm text-stone-600">The repository is published at launch. Until then, <a href="mailto:hello@evenbooks.org" className="font-medium text-brand-700 underline-offset-4 hover:underline">write to us</a> for early access.</p>
        )}
      </section>

      <p className="mt-12 text-sm text-stone-500">
        See also <Link href="/how-we-make-money" className="font-medium text-brand-700 underline-offset-4 hover:underline">How we make money</Link>.
      </p>
    </article>
  );
}
