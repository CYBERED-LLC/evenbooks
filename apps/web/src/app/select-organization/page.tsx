import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Wordmark } from '@/components/brand/mark';
import { authModeFromEnv } from '@/server/env';

export const dynamic = 'force-dynamic';

export default async function SelectOrganizationPage() {
  if (authModeFromEnv() === 'dev') redirect('/dev-login');
  const { OrganizationList } = await import('@clerk/nextjs');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <Link href="/" aria-label="Evenbooks home" className="mb-2">
        <Wordmark size="lg" />
      </Link>
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Choose a company</h1>
        <p className="mt-1 text-sm text-stone-600">Each company keeps its own books. Pick one to continue, or create a new one.</p>
      </div>
      <OrganizationList hidePersonal afterSelectOrganizationUrl="/dashboard" afterCreateOrganizationUrl="/dashboard" />
    </main>
  );
}
