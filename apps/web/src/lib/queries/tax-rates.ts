'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTaxRateInput, TaxRateDto, UpdateTaxRateInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type TaxRateListParams = {
  includeInactive?: boolean;
  /** Adds `usage` (items and open invoices per rate); the settings page asks for it, pickers do not. */
  withUsage?: boolean;
};

export function taxRatesOptions(companyId: string, params: TaxRateListParams = {}) {
  return queryOptions({
    queryKey: [...qk.taxRates.all(companyId), 'list', params] as const,
    queryFn: ({ signal }) =>
      api<TaxRateDto[]>('/api/tax-rates', { companyId, signal, query: { includeInactive: params.includeInactive ? true : undefined, withUsage: params.withUsage ? true : undefined } }),
    // Usage moves with every issued or paid invoice; the bare list only changes when rates do.
    staleTime: params.withUsage ? 30_000 : 5 * 60_000,
  });
}

export function useTaxRates(params: TaxRateListParams = {}) {
  const { company } = useCompany();
  return useQuery(taxRatesOptions(company.id, params));
}

export function useCreateTaxRate() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaxRateInput) => api<TaxRateDto>('/api/tax-rates', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.taxRates.all(company.id) }),
  });
}

/** Optimistic metadata edit (name, agency, active flag) with rollback. */
export function useUpdateTaxRate() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTaxRateInput }) =>
      api<TaxRateDto>(`/api/tax-rates/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: qk.taxRates.all(company.id) });
      const snapshots = qc.getQueriesData<TaxRateDto[]>({ queryKey: qk.taxRates.all(company.id) });
      const { version: _v, ...patch } = input;
      qc.setQueriesData<TaxRateDto[]>({ queryKey: qk.taxRates.all(company.id) }, (old) =>
        old?.map((t) => (t.id === id ? { ...t, ...(patch as Partial<TaxRateDto>) } : t)),
      );
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.taxRates.all(company.id) }),
  });
}

// ---------------------------------------------------------------------------
// Rate formatting. The API stores a decimal fraction ("0.0825"); the UI works in
// percent ("8.25"). Both directions are string digit shifts, never float math.
// ---------------------------------------------------------------------------

const PERCENT_RE = /^\d+(\.\d+)?$/;

/** "0.0825" -> "8.25%"; "0" -> "0%". */
export function fractionToPercent(fraction: string): string {
  if (!PERCENT_RE.test(fraction)) return fraction;
  const [intPart = '0', fracPart = ''] = fraction.split('.');
  const digits = fracPart.padEnd(2, '0');
  const int = (intPart + digits.slice(0, 2)).replace(/^0+(?=\d)/, '');
  const rest = digits.slice(2).replace(/0+$/, '');
  return `${int}${rest ? '.' + rest : ''}%`;
}

/**
 * "8.25" -> "0.0825". Returns null when the input is not a percent in [0, 100)
 * or would need more than 6 decimal places as a fraction.
 */
export function percentToFraction(percent: string): string | null {
  const s = percent.trim();
  if (!PERCENT_RE.test(s)) return null;
  const [rawInt = '0', fracPart = ''] = s.split('.');
  if (Number.parseFloat(s) >= 100 || fracPart.length > 4) return null;
  // Dividing by 100 is a two-place shift: pad the whole part to two digits and
  // move everything after the point. 8.25 -> "08" + "25" -> 0.0825
  const intPart = rawInt.replace(/^0+(?=\d)/, '').padStart(2, '0');
  const digits = (intPart + fracPart).replace(/0+$/, '');
  return digits ? `0.${digits}` : '0';
}
