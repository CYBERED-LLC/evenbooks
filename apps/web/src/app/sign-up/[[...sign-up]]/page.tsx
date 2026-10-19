import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Wordmark } from '@/components/brand/mark';
import { authModeFromEnv } from '@/server/env';

export const dynamic = 'force-dynamic';

export default async function SignUpPage() {
  if (authModeFromEnv() === 'dev') redirect('/dev-login');
  const { SignUp } = await import('@clerk/nextjs');
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <Link href="/" aria-label="Evenbooks home">
        <Wordmark size="lg" />
      </Link>
      <SignUp />
      <p className="text-sm text-stone-600">Free for one person. No card needed.</p>
    </main>
  );
}
