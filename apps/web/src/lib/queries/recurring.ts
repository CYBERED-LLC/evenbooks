'use client';
import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CreateScheduleInput, ResumeScheduleInput, ScheduleDto, UpdateScheduleInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export interface RunScheduleResult {
  issued: string[];
  skippedExisting: number;
}

export function schedulesOptions(companyId: string) {
  return queryOptions({
    queryKey: [...qk.recurring.all(companyId), 'list'] as const,
    queryFn: ({ signal }) => api<ScheduleDto[]>('/api/recurring', { companyId, signal }),
    staleTime: 15_000,
  });
}

export function scheduleDetailOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.recurring.detail(companyId, id),
    queryFn: ({ signal }) => api<ScheduleDto>(`/api/recurring/${id}`, { companyId, signal }),
  });
}

export function useSchedules() {
  const { company } = useCompany();
  return useQuery(schedulesOptions(company.id));
}

export function useSchedule(id: string) {
  const { company } = useCompany();
  return useQuery(scheduleDetailOptions(company.id, id));
}

export function usePrefetchSchedule() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return (id: string) => void qc.prefetchQuery(scheduleDetailOptions(company.id, id));
}

/** Schedule actions may issue invoices (resume with catch-up, run), so everything a posting touches is refreshed. */
function invalidateAfterScheduleAction(qc: QueryClient, companyId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: qk.recurring.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.invoices.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.contacts.all(companyId) }),
    ...postingAffectedKeys(companyId).map((key) => qc.invalidateQueries({ queryKey: key })),
  ]);
}

export function useCreateSchedule() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScheduleInput) => api<ScheduleDto>('/api/recurring', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (s) => {
      qc.setQueryData(qk.recurring.detail(company.id, s.id), s);
      return qc.invalidateQueries({ queryKey: qk.recurring.all(company.id) });
    },
  });
}

export function useUpdateSchedule(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateScheduleInput) => api<ScheduleDto>(`/api/recurring/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onSuccess: (s) => {
      qc.setQueryData(qk.recurring.detail(company.id, id), s);
      return qc.invalidateQueries({ queryKey: qk.recurring.all(company.id) });
    },
  });
}

export function usePauseSchedule(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: number }) => api<ScheduleDto>(`/api/recurring/${id}/pause`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (s) => {
      qc.setQueryData(qk.recurring.detail(company.id, id), s);
      return invalidateAfterScheduleAction(qc, company.id);
    },
  });
}

export function useResumeSchedule(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ResumeScheduleInput) => api<ScheduleDto>(`/api/recurring/${id}/resume`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (s) => {
      qc.setQueryData(qk.recurring.detail(company.id, id), s);
      return invalidateAfterScheduleAction(qc, company.id);
    },
  });
}

export function useCancelSchedule(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: number; reason: string }) =>
      api<ScheduleDto>(`/api/recurring/${id}/cancel`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (s) => {
      qc.setQueryData(qk.recurring.detail(company.id, id), s);
      return invalidateAfterScheduleAction(qc, company.id);
    },
  });
}

/** "Issue due now": same code path as the worker; safe to repeat (existing occurrences are skipped). */
export function useRunSchedule(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<RunScheduleResult>(`/api/recurring/${id}/run`, { method: 'POST', companyId: company.id }),
    onSuccess: () => invalidateAfterScheduleAction(qc, company.id),
  });
}
