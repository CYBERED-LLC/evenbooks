import { redirect } from 'next/navigation';
import { env } from '@/server/env';
import { DEV_ORGS, DEV_USERS } from '@/server/dev-auth';
import { DevLoginForm } from './form';

export const dynamic = 'force-dynamic';

export default function DevLoginPage() {
  if (env().authMode !== 'dev') redirect('/sign-in');
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-lg border border-stone-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Development sign-in</h1>
        <p className="mt-1 text-sm text-stone-600">
          Clerk is not configured. Choose a local user and company. This mode is disabled in production.
        </p>
        <DevLoginForm users={DEV_USERS} orgs={DEV_ORGS} />
      </div>
    </main>
  );
}
