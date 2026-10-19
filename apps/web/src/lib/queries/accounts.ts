'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountDto, CreateAccountInput, UpdateAccountInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export function accountsOptions(companyId: string, params: { includeArchived?: boolean; withBalances?: boolean } = {}) {
  return queryOptions({
    queryKey: qk.accounts.list(companyId, params),
    queryFn: ({ signal }) => api<AccountDto[]>('/api/accounts', { companyId, signal, query: params }),
    staleTime: 5 * 60_000,
  });
}

export function useAccounts(params: { includeArchived?: boolean; withBalances?: boolean } = {}) {
  const { company } = useCompany();
  return useQuery(accountsOptions(company.id, params));
}

export function useCreateAccount() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAccountInput) => api<AccountDto>('/api/accounts', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (_a, input) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.accounts.all(company.id) }),
        // A tax-form line saved with the account changes the year's mappings and the Schedule C summary.
        ...(input.scheduleCLine ? [qc.invalidateQueries({ queryKey: qk.mappings.all(company.id) }), qc.invalidateQueries({ queryKey: qk.reports.all(company.id) })] : []),
      ]),
  });
}

/** Optimistic metadata edit (name/code/description/archive) with rollback. */
export function useUpdateAccount() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateAccountInput }) =>
      api<AccountDto>(`/api/accounts/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: qk.accounts.all(company.id) });
      const snapshots = qc.getQueriesData<AccountDto[]>({ queryKey: qk.accounts.all(company.id) });
      qc.setQueriesData<AccountDto[]>({ queryKey: qk.accounts.all(company.id) }, (old) =>
        old?.map((a) => (a.id === id ? { ...a, ...stripVersion(input) } : a)),
      );
      return { snapshots };
    },
    onError: (_err, _vars, onMutateResult) => {
      for (const [key, data] of onMutateResult?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.accounts.all(company.id) }),
  });
}

function stripVersion(input: UpdateAccountInput): Partial<AccountDto> {
  const { version: _v, ...rest } = input;
  return rest as Partial<AccountDto>;
}
