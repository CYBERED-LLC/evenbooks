'use client';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { CompanyDto, UpdateCompanyInput } from '@evenbooks/contracts';
import { ApiClientError, api } from '@/lib/api-client';
import { useCompany } from '@/components/company-context';

export function useUpdateCompany() {
  const { company } = useCompany();
  const router = useRouter();
  return useMutation({
    mutationFn: (input: UpdateCompanyInput) => api<CompanyDto>('/api/company', { method: 'PATCH', body: input, companyId: company.id }),
    // Company settings come from the server layout; refresh RSC data instead of a page reload.
    onSuccess: () => router.refresh(),
  });
}

/**
 * Save a few fields no other screen changes on its own (setup answers, the checklist flag).
 * Issuing an invoice bumps the company's version, so on a version conflict this reloads the
 * company once and saves again instead of asking the owner to reload.
 */
export function useSaveCompanyFields() {
  const { company } = useCompany();
  const router = useRouter();
  return useMutation({
    mutationFn: async (input: Omit<UpdateCompanyInput, 'version'>) => {
      const patch = (version: number) => api<CompanyDto>('/api/company', { method: 'PATCH', body: { ...input, version }, companyId: company.id });
      try {
        return await patch(company.version);
      } catch (e) {
        if (!(e instanceof ApiClientError && e.code === 'version_conflict')) throw e;
        const fresh = await api<CompanyDto>('/api/company', { companyId: company.id });
        return patch(fresh.version);
      }
    },
    onSuccess: () => router.refresh(),
  });
}
