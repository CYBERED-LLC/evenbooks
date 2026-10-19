import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/server/auth';
import { env } from '@/server/env';
import HomePage from './_home';
import { currentDemoMonth } from './_home/demo-month';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Evenbooks · Honest double-entry bookkeeping for small companies' },
  description: 'Bookkeeping that shows its work. Invoices, bank feeds, online payments and real double-entry books, with one fair price and no upsells. Source-available.',
};

/** Signed-in people go to their books; everyone else sees the homepage. */
export default async function Home() {
  const session = await getSession();
  if (session) {
    if (!session.orgId) redirect(env().authMode === 'dev' ? '/dev-login' : '/select-organization');
    redirect('/dashboard');
  }
  return <HomePage month={currentDemoMonth()} />;
}
