'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClosePeriodInput, PeriodDto, ReopenPeriodInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export function periodsOptions(companyId: string) {
  return queryOptions({
    queryKey: qk.periods.all(companyId),
    queryFn: ({ signal }) => api<PeriodDto[]>('/api/periods', { companyId, signal }),
    staleTime: 60_000,
  });
}

export function usePeriods() {
  const { company } = useCompany();
  return useQuery(periodsOptions(company.id));
}

export function useClosePeriod() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ClosePeriodInput) => api<PeriodDto>('/api/periods', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.periods.all(company.id) }), qc.invalidateQueries({ queryKey: qk.audit.all(company.id) })]),
  });
}

export function useReopenPeriod() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReopenPeriodInput }) =>
      api<PeriodDto>(`/api/periods/${id}/reopen`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.periods.all(company.id) }), qc.invalidateQueries({ queryKey: qk.audit.all(company.id) })]),
  });
}

export function useReclosePeriod() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version, reason }: { id: string; version: number; reason?: string }) =>
      api<PeriodDto>(`/api/periods/${id}/close`, { method: 'POST', body: { version, reason }, companyId: company.id }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: qk.periods.all(company.id) }), qc.invalidateQueries({ queryKey: qk.audit.all(company.id) })]),
  });
}
