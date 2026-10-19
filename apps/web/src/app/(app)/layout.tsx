import { redirect } from 'next/navigation';
import { AuthError, getPrincipal } from '@/server/company';
import { env } from '@/server/env';
import { CompanyProvider } from '@/components/company-context';
import { CompanyCacheScope } from '@/components/providers';
import { AppShell } from '@/components/app-shell';
import { serverFeatures } from '@/server/processor';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const e = env();
  let principal;
  try {
    principal = await getPrincipal();
  } catch (err) {
    if (err instanceof AuthError && err.kind === 'no_organization') redirect(e.authMode === 'dev' ? '/dev-login' : '/select-organization');
    throw err;
  }
  if (!principal) redirect(e.authMode === 'dev' ? '/dev-login' : '/sign-in');

  return (
    <CompanyProvider
      value={{
        company: principal.company,
        role: principal.role,
        userId: principal.session.userId,
        userName: principal.session.userName,
        authMode: e.authMode,
        memberLimit: principal.memberLimit,
        features: serverFeatures(),
      }}
    >
      <CompanyCacheScope companyId={principal.company.id} userId={principal.session.userId}>
        <AppShell>{children}</AppShell>
      </CompanyCacheScope>
    </CompanyProvider>
  );
}
