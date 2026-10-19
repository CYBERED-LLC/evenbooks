'use client';
import { keepPreviousData, queryOptions, useQuery } from '@tanstack/react-query';
import type { AuditEventDto, Page } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type AuditParams = {
  limit?: number;
  cursor?: string;
  entityType?: string;
  entityId?: string;
  [key: string]: string | number | undefined;
};

export function auditOptions(companyId: string, params: AuditParams) {
  return queryOptions({
    queryKey: qk.audit.list(companyId, params),
    queryFn: ({ signal }) => api<Page<AuditEventDto>>('/api/audit', { companyId, signal, query: params }),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

export function useAudit(params: AuditParams) {
  const { company } = useCompany();
  return useQuery(auditOptions(company.id, params));
}
