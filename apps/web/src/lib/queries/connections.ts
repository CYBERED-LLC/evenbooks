'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BankConnectionDto, ConnectSimpleFinInput, DiscoveredAccountDto, LinkProviderAccountsInput, SyncResultDto } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export interface UpdateConnectionInput {
  version: number;
  name?: string;
  syncIntervalMinutes?: number;
  status?: 'active' | 'disabled';
}

export function connectionsOptions(companyId: string) {
  return queryOptions({
    queryKey: qk.banking.connections(companyId),
    queryFn: ({ signal }) => api<BankConnectionDto[]>('/api/banking/connections', { companyId, signal }),
    staleTime: 15_000,
  });
}

export function useConnections() {
  const { company } = useCompany();
  return useQuery(connectionsOptions(company.id));
}

/** Provider-side account list (admin). Always fresh: it drives a linking decision. */
export function useDiscoverAccounts(connectionId: string | null) {
  const { company } = useCompany();
  return useQuery({
    queryKey: [...qk.banking.connections(company.id), 'discover', connectionId ?? ''] as const,
    queryFn: ({ signal }) => api<DiscoveredAccountDto[]>(`/api/banking/connections/${connectionId}/discover`, { companyId: company.id, signal }),
    enabled: Boolean(connectionId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

function useConnectionMutation<TInput, TResult>(mutationFn: (input: TInput, companyId: string) => Promise<TResult>) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => mutationFn(input, company.id),
    // Linking and syncing change bank accounts and imported transactions too, so the whole banking area refreshes.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.banking.all(company.id) }),
  });
}

export function useConnectSimpleFin() {
  return useConnectionMutation((input: ConnectSimpleFinInput, companyId) =>
    api<BankConnectionDto>('/api/banking/connections', { method: 'POST', body: input, companyId }),
  );
}

export function useUpdateConnection() {
  return useConnectionMutation(({ id, input }: { id: string; input: UpdateConnectionInput }, companyId) =>
    api<BankConnectionDto>(`/api/banking/connections/${id}`, { method: 'PATCH', body: input, companyId }),
  );
}

export function useLinkProviderAccounts() {
  return useConnectionMutation(({ id, input }: { id: string; input: LinkProviderAccountsInput }, companyId) =>
    api<BankConnectionDto>(`/api/banking/connections/${id}/link`, { method: 'POST', body: input, companyId }),
  );
}

export function useReconnectConnection() {
  return useConnectionMutation(({ id, input }: { id: string; input: { version: number; setupToken: string } }, companyId) =>
    api<BankConnectionDto>(`/api/banking/connections/${id}/reconnect`, { method: 'POST', body: input, companyId }),
  );
}

export function useDisconnectConnection() {
  return useConnectionMutation(({ id, version }: { id: string; version: number }, companyId) =>
    api<BankConnectionDto>(`/api/banking/connections/${id}/disconnect`, { method: 'POST', body: { version }, companyId }),
  );
}

/** The result toast should not wait for the banking refetches, so invalidation is fire-and-forget here. */
export function useSyncConnection() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<SyncResultDto>(`/api/banking/connections/${id}/sync`, { method: 'POST', companyId: company.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.banking.all(company.id) });
    },
  });
}
