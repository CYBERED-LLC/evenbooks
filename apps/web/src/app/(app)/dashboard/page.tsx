import { HydrationBoundary, dehydrate } from '@tanstack/react-query';
import { getQueryClient } from '@/lib/query-client';
import { requirePrincipal } from '@/server/company';
import { inCompany } from '@/server/api';
import { listAccounts } from '@evenbooks/services';
import { qk } from '@/lib/query-keys';
import { DashboardView } from './view';

export const metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const principal = await requirePrincipal();
  const qc = getQueryClient();
  // Server-side prefetch of authorized data only; hydrated into the per-request client.
  await qc.prefetchQuery({
    queryKey: qk.accounts.list(principal.company.id, { withBalances: true }),
    queryFn: () => inCompany(principal, (s) => listAccounts(s, { withBalances: true })),
  });
  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <DashboardView />
    </HydrationBoundary>
  );
}
