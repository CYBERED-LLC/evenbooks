'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';
import type { AccountDto, CreateItemInput, ItemDto, UpdateItemInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';
import { useAccounts } from '@/lib/queries/accounts';

export type ItemListParams = {
  includeInactive?: boolean;
};

export function itemsOptions(companyId: string, params: ItemListParams = {}) {
  return queryOptions({
    queryKey: qk.items.list(companyId, params),
    queryFn: ({ signal }) =>
      api<ItemDto[]>('/api/items', { companyId, signal, query: { includeInactive: params.includeInactive ? true : undefined } }),
    staleTime: 5 * 60_000,
  });
}

export function useItems(params: ItemListParams = {}) {
  const { company } = useCompany();
  return useQuery(itemsOptions(company.id, params));
}

export function useCreateItem() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateItemInput) => api<ItemDto>('/api/items', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.items.all(company.id) }),
  });
}

/** Optimistic metadata edit (name, price, account, active flag) with rollback. */
export function useUpdateItem() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateItemInput }) =>
      api<ItemDto>(`/api/items/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: qk.items.all(company.id) });
      const snapshots = qc.getQueriesData<ItemDto[]>({ queryKey: qk.items.all(company.id) });
      const { version: _v, ...patch } = input;
      qc.setQueriesData<ItemDto[]>({ queryKey: qk.items.all(company.id) }, (old) => old?.map((i) => (i.id === id ? { ...i, ...(patch as Partial<ItemDto>) } : i)));
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.items.all(company.id) }),
  });
}

// ---------------------------------------------------------------------------
// Default income category (new items and invoice lines)
// ---------------------------------------------------------------------------
/** Names of the starter chart's everyday income categories, in order of preference. */
const MAIN_INCOME_NAMES = ['sales', 'service revenue'];

/**
 * The category a new invoice line lands in when the owner doesn't pick one: an active
 * "Sales" or "Service Revenue" income account, else the first active income account
 * without a system role, else any active income account.
 */
export function mainIncomeAccount(accounts: AccountDto[] | undefined): AccountDto | null {
  const income = (accounts ?? []).filter((a) => a.isActive && a.type === 'income').sort((a, b) => a.code.localeCompare(b.code));
  for (const name of MAIN_INCOME_NAMES) {
    const hit = income.find((a) => !a.role && a.name.trim().toLowerCase() === name);
    if (hit) return hit;
  }
  return income.find((a) => !a.role) ?? income[0] ?? null;
}

/** Id of `mainIncomeAccount` for this company, or null while accounts load (or none exist). */
export function useDefaultIncomeAccountId(): string | null {
  const accounts = useAccounts();
  return React.useMemo(() => mainIncomeAccount(accounts.data)?.id ?? null, [accounts.data]);
}
