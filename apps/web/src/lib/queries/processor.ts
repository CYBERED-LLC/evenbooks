'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ConnectProcessorResultDto,
  LinkProcessorResultDto,
  ProcessorChargeDto,
  ProcessorConnectionDto,
  ProcessorPayoutDto,
  ProcessorRefundDto,
  RefundProcessorChargeInput,
  UpdateProcessorConnectionInput,
} from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

// Keys are composed locally (query-keys.ts is frozen); every key starts with the company scope.
const keys = {
  all: (c: string) => [...qk.company(c), 'processor'] as const,
  connection: (c: string) => [...qk.company(c), 'processor', 'connection'] as const,
  charges: (c: string, params: Record<string, unknown>) => [...qk.company(c), 'processor', 'charges', params] as const,
  charge: (c: string, id: string) => [...qk.company(c), 'processor', 'charge', id] as const,
  payouts: (c: string) => [...qk.company(c), 'processor', 'payouts'] as const,
};
export const processorKeys = keys;

export type ProcessorChargeDetail = ProcessorChargeDto & { refunds: ProcessorRefundDto[] };

export function processorConnectionOptions(companyId: string) {
  return queryOptions({
    queryKey: keys.connection(companyId),
    queryFn: ({ signal }) => api<ProcessorConnectionDto | null>('/api/processor/connection', { companyId, signal }),
    staleTime: 15_000,
  });
}

export function useProcessorConnection() {
  const { company } = useCompany();
  return useQuery(processorConnectionOptions(company.id));
}

export function useProcessorCharges(params: { invoiceId?: string; status?: ProcessorChargeDto['status']; limit?: number } = {}, enabled = true) {
  const { company } = useCompany();
  return useQuery({
    queryKey: keys.charges(company.id, params),
    queryFn: ({ signal }) => api<ProcessorChargeDto[]>('/api/processor/charges', { companyId: company.id, signal, query: params }),
    staleTime: 10_000,
    enabled,
  });
}

export function useProcessorCharge(id: string | null) {
  const { company } = useCompany();
  return useQuery({
    queryKey: keys.charge(company.id, id ?? ''),
    queryFn: ({ signal }) => api<ProcessorChargeDetail>(`/api/processor/charges/${id}`, { companyId: company.id, signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  });
}

export function useProcessorPayouts(enabled = true) {
  const { company } = useCompany();
  return useQuery({
    queryKey: keys.payouts(company.id),
    queryFn: ({ signal }) => api<ProcessorPayoutDto[]>('/api/processor/payouts', { companyId: company.id, signal }),
    staleTime: 15_000,
    enabled,
  });
}

function useProcessorMutation<TInput, TResult>(mutationFn: (input: TInput, companyId: string) => Promise<TResult>, alsoPosting = false) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => mutationFn(input, company.id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.all(company.id) });
      if (alsoPosting) {
        await Promise.all([...postingAffectedKeys(company.id), qk.invoices.all(company.id), qk.payments.all(company.id)].map((k) => qc.invalidateQueries({ queryKey: k })));
      }
    },
  });
}

/** Start or resume onboarding; the caller redirects the browser to `onboardingUrl`. */
export function useConnectProcessor() {
  return useProcessorMutation((_: void, companyId) => api<ConnectProcessorResultDto>('/api/processor/connection/connect', { method: 'POST', companyId }));
}

/** Connect an existing Stripe account; the caller redirects the browser to Stripe's sign-in `url`. */
export function useLinkProcessor() {
  return useProcessorMutation((_: void, companyId) => api<LinkProcessorResultDto>('/api/processor/connection/link', { method: 'POST', companyId }));
}

export function useRefreshProcessorConnection() {
  return useProcessorMutation((_: void, companyId) => api<ProcessorConnectionDto>('/api/processor/connection/refresh', { method: 'POST', companyId }));
}

export function useUpdateProcessorConnection() {
  return useProcessorMutation((input: UpdateProcessorConnectionInput, companyId) => api<ProcessorConnectionDto>('/api/processor/connection', { method: 'PATCH', body: input, companyId }));
}

export function useDisconnectProcessor() {
  return useProcessorMutation((input: { version: number }, companyId) => api<ProcessorConnectionDto>('/api/processor/connection/disconnect', { method: 'POST', body: input, companyId }));
}

/** Refund through the processor: posts to the ledger, so posting-affected caches refresh too. */
export function useRefundProcessorCharge() {
  return useProcessorMutation(({ id, input }: { id: string; input: RefundProcessorChargeInput }, companyId) => api<ProcessorRefundDto>(`/api/processor/charges/${id}/refund`, { method: 'POST', body: input, companyId }), true);
}
