'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FailedJobRetryDto, JobStatusDto, RetryJobResultDto } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type FailedJobRetry = FailedJobRetryDto;
export type FailedJob = JobStatusDto['failedJobs'][number];
export type JobStatus = JobStatusDto;
export type RetryJobResult = RetryJobResultDto;

export function jobStatusOptions(companyId: string) {
  return queryOptions({
    queryKey: qk.jobs.status(companyId),
    queryFn: ({ signal }) => api<JobStatus>('/api/jobs/status', { companyId, signal }),
    staleTime: 10_000,
  });
}

/** Polls while the page is visible; a hidden tab stops polling until it is focused again. */
export function useJobStatus(enabled = true) {
  const { company } = useCompany();
  return useQuery({
    ...jobStatusOptions(company.id),
    enabled,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

/** Admin: re-run a failed job through the outbox. Safe to repeat; the server queues one retry per failed job. */
export function useRetryJob() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api<RetryJobResult>(`/api/jobs/${jobId}/retry`, { method: 'POST', companyId: company.id }),
    onSettled: () => qc.invalidateQueries({ queryKey: qk.jobs.all(company.id) }),
  });
}
