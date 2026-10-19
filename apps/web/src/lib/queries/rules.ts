'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateRuleInput, RuleDto, UpdateRuleInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export function rulesOptions(companyId: string) {
  return queryOptions({
    queryKey: qk.banking.rules(companyId),
    queryFn: ({ signal }) => api<RuleDto[]>('/api/banking/rules', { companyId, signal }),
    staleTime: 30_000,
  });
}

export function useRules() {
  const { company } = useCompany();
  return useQuery(rulesOptions(company.id));
}

/** Rules change which suggestions the inbox shows, so invalidate the whole banking tree. */
function invalidateRules(qc: ReturnType<typeof useQueryClient>, companyId: string) {
  return qc.invalidateQueries({ queryKey: qk.banking.all(companyId) });
}

export function useCreateRule() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRuleInput) => api<RuleDto>('/api/banking/rules', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => invalidateRules(qc, company.id),
  });
}

export function useUpdateRule() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateRuleInput }) =>
      api<RuleDto>(`/api/banking/rules/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onSuccess: () => invalidateRules(qc, company.id),
  });
}

export function useDeleteRule() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/banking/rules/${id}`, { method: 'DELETE', companyId: company.id }),
    onSuccess: () => invalidateRules(qc, company.id),
  });
}

/** Switch a rule on or off. Optimistic: it is reversible metadata, not financial state. */
export function useToggleRule() {
  const { company } = useCompany();
  const qc = useQueryClient();
  const key = qk.banking.rules(company.id);
  return useMutation({
    mutationFn: ({ rule, isActive }: { rule: RuleDto; isActive: boolean }) =>
      api<RuleDto>(`/api/banking/rules/${rule.id}`, { method: 'PATCH', body: { version: rule.version, isActive } satisfies UpdateRuleInput, companyId: company.id }),
    onMutate: async ({ rule, isActive }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<RuleDto[]>(key);
      qc.setQueryData<RuleDto[]>(key, (rows) => rows?.map((r) => (r.id === rule.id ? { ...r, isActive } : r)));
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous);
    },
    onSettled: () => invalidateRules(qc, company.id),
  });
}
