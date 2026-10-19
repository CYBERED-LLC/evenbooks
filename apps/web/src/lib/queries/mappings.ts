'use client';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type ScheduleCLinePart = 'income' | 'expense' | 'other';

export interface ScheduleCLineDef {
  code: string;
  label: string;
  part: ScheduleCLinePart | string;
  note?: string;
}

export interface MappingAccount {
  id: string;
  code: string;
  name: string;
  type: 'income' | 'expense' | string;
  isActive: boolean;
  /** Schedule C line code, `'excluded'` for "not on Schedule C", or null when unmapped. */
  lineCode: string | null;
}

export interface MappingsDto {
  taxYear: number;
  lines: ScheduleCLineDef[];
  accounts: MappingAccount[];
}

export interface MappingEntry {
  accountId: string;
  lineCode: string | null;
}

/** Sentinel line code meaning "intentionally not on Schedule C". */
export const EXCLUDED_LINE_CODE = 'excluded';

export function mappingsOptions(companyId: string, year: number) {
  return queryOptions({
    queryKey: qk.mappings.year(companyId, year),
    queryFn: ({ signal }) => api<MappingsDto>(`/api/mappings/${year}`, { companyId, signal }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

export function useMappings(year: number, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...mappingsOptions(company.id, year), enabled });
}

/** Admin: one PUT with every changed entry; the server returns the full year afterwards. */
export function useSaveMappings(year: number) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (entries: MappingEntry[]) => api<MappingsDto>(`/api/mappings/${year}`, { method: 'PUT', body: { entries }, companyId: company.id }),
    onSuccess: (data) => {
      qc.setQueryData(qk.mappings.year(company.id, year), data);
      // The Schedule C summary is derived from mappings.
      return qc.invalidateQueries({ queryKey: qk.reports.all(company.id) });
    },
  });
}

/** Admin: copy every mapping from another year into this one. */
export function useCopyMappings(year: number) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fromYear: number) => api<MappingsDto & { copied: number }>(`/api/mappings/${year}/copy`, { method: 'POST', body: { fromYear }, companyId: company.id }),
    onSuccess: (data) => {
      const { copied: _copied, ...rest } = data;
      qc.setQueryData(qk.mappings.year(company.id, year), rest);
      return qc.invalidateQueries({ queryKey: qk.reports.all(company.id) });
    },
  });
}
