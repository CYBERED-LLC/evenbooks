'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronsUpDown } from 'lucide-react';
import { useCompany } from '@/components/company-context';
import { LazyClerk } from '@/components/clerk-portal';

/**
 * Company (organization) switcher. In Clerk mode this renders Clerk's
 * OrganizationSwitcher; in dev mode a small select posting to /api/dev-auth.
 * Either way the server re-resolves the company on the next request, and the
 * app layout remounts with a fresh cache scope.
 */
export function CompanySwitcher() {
  const { authMode, company } = useCompany();
  if (authMode === 'clerk') return <ClerkSwitcher />;
  return <DevSwitcher current={company.clerkOrgId} />;
}

function ClerkSwitcher() {
  return (
    <LazyClerk
      name="OrganizationSwitcher"
      fallback={<div className="h-9 rounded-md bg-stone-100" aria-hidden />}
      className="rounded-md border border-stone-300 bg-white px-2 py-1"
      hidePersonal
      afterSelectOrganizationUrl="/dashboard"
      afterCreateOrganizationUrl="/dashboard"
    />
  );
}

function DevSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const [orgs, setOrgs] = React.useState<{ orgId: string; orgName: string }[]>([]);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    void fetch('/api/dev-auth')
      .then((r) => r.json())
      .then((d: { orgs: { orgId: string; orgName: string }[] }) => setOrgs(d.orgs))
      .catch(() => {});
  }, []);
  return (
    <div className="relative">
      <select
        aria-label="Switch company"
        className="h-9 w-full appearance-none rounded-md border border-stone-300 bg-white pl-3 pr-8 text-sm font-medium"
        value={current}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          await fetch('/api/dev-auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgId: e.target.value }) });
          router.push('/dashboard');
          router.refresh();
          setBusy(false);
        }}
      >
        {orgs.length === 0 && <option value={current}>Loading…</option>}
        {orgs.map((o) => (
          <option key={o.orgId} value={o.orgId}>
            {o.orgName}
          </option>
        ))}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute right-2 top-2.5 size-4 text-stone-500" aria-hidden />
    </div>
  );
}
