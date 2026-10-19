'use client';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AllocatePaymentInput,
  CreatePaymentInput,
  CreateRefundInput,
  CustomerBalanceDto,
  InvoiceDto,
  ListPaymentsQuery,
  Page,
  PaymentDto,
  RefundDto,
  ReverseAllocationInput,
  VoidPaymentInput,
} from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type PaymentListParams = Partial<ListPaymentsQuery>;

export function paymentListOptions(companyId: string, params: PaymentListParams) {
  return queryOptions({
    queryKey: qk.payments.list(companyId, params),
    queryFn: ({ signal }) =>
      api<Page<PaymentDto>>('/api/payments', {
        companyId,
        signal,
        // `unappliedOnly` is coerced server-side, so only send it when true.
        query: {
          contactId: params.contactId,
          from: params.from,
          to: params.to,
          status: params.status,
          q: params.q,
          sort: params.sort,
          dir: params.dir,
          limit: params.limit,
          cursor: params.cursor,
          unappliedOnly: params.unappliedOnly ? true : undefined,
        },
      }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function paymentDetailOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.payments.detail(companyId, id),
    queryFn: ({ signal }) => api<PaymentDto>(`/api/payments/${id}`, { companyId, signal }),
  });
}

export function usePayments(params: PaymentListParams) {
  const { company } = useCompany();
  return useQuery(paymentListOptions(company.id, params));
}

export function usePayment(id: string) {
  const { company } = useCompany();
  return useQuery(paymentDetailOptions(company.id, id));
}

export function usePrefetchPayment() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return (id: string) => void qc.prefetchQuery(paymentDetailOptions(company.id, id));
}

// ---------------------------------------------------------------------------
// Customer balance (open invoices) and invoice lookup for prefill
// ---------------------------------------------------------------------------
export function customerBalanceOptions(companyId: string, contactId: string) {
  return queryOptions({
    queryKey: [...qk.contacts.detail(companyId, contactId), 'balance'] as const,
    queryFn: ({ signal }) => api<CustomerBalanceDto>(`/api/contacts/${contactId}/balance`, { companyId, signal }),
    staleTime: 10_000,
  });
}

export function useCustomerBalance(contactId: string | null | undefined) {
  const { company } = useCompany();
  return useQuery({ ...customerBalanceOptions(company.id, contactId ?? ''), enabled: Boolean(contactId) });
}

/** Read-only invoice lookup used to prefill the payment form from `?invoiceId=`. */
export function useInvoiceForPrefill(invoiceId: string | null | undefined) {
  const { company } = useCompany();
  return useQuery({
    queryKey: qk.invoices.detail(company.id, invoiceId ?? ''),
    queryFn: ({ signal }) => api<InvoiceDto>(`/api/invoices/${invoiceId}`, { companyId: company.id, signal }),
    enabled: Boolean(invoiceId),
  });
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
export type RefundListParams = { paymentId?: string; creditNoteId?: string; contactId?: string };

export function refundListOptions(companyId: string, params: RefundListParams = {}) {
  return queryOptions({
    queryKey: [...qk.payments.all(companyId), 'refunds', params] as const,
    queryFn: ({ signal }) => api<RefundDto[]>('/api/refunds', { companyId, signal, query: params }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useRefunds(params: RefundListParams = {}) {
  const { company } = useCompany();
  return useQuery(refundListOptions(company.id, params));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
function invalidateAfterSettlement(qc: ReturnType<typeof useQueryClient>, companyId: string) {
  return Promise.all([
    ...postingAffectedKeys(companyId).map((key) => qc.invalidateQueries({ queryKey: key })),
    qc.invalidateQueries({ queryKey: qk.payments.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.invoices.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.creditNotes.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.contacts.all(companyId) }),
  ]);
}

export function useCreatePayment() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentInput) => api<PaymentDto>('/api/payments', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (p) => {
      qc.setQueryData(qk.payments.detail(company.id, p.id), p);
      return invalidateAfterSettlement(qc, company.id);
    },
  });
}

export function useAllocatePayment(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AllocatePaymentInput) => api<PaymentDto>(`/api/payments/${id}/allocate`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (p) => {
      qc.setQueryData(qk.payments.detail(company.id, id), p);
      return invalidateAfterSettlement(qc, company.id);
    },
  });
}

export function useVoidPayment(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VoidPaymentInput) => api<PaymentDto>(`/api/payments/${id}/void`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (p) => {
      qc.setQueryData(qk.payments.detail(company.id, id), p);
      return invalidateAfterSettlement(qc, company.id);
    },
  });
}

/** Reverses one allocation (payment or credit note). The server returns the reversal details; we refetch everything affected. */
export function useReverseAllocation() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ allocationId, input }: { allocationId: string; input: ReverseAllocationInput }) =>
      api<unknown>(`/api/allocations/${allocationId}/reverse`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => invalidateAfterSettlement(qc, company.id),
  });
}

export function useCreateRefund() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRefundInput) => api<RefundDto>('/api/refunds', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => invalidateAfterSettlement(qc, company.id),
  });
}

export function useVoidRefund() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason, idempotencyKey }: { id: string; reason: string; idempotencyKey: string }) =>
      api<RefundDto>(`/api/refunds/${id}/void`, { method: 'POST', body: { reason, idempotencyKey }, companyId: company.id }),
    onSuccess: () => invalidateAfterSettlement(qc, company.id),
  });
}

export const PAYMENT_METHODS = ['cash', 'check', 'card', 'ach', 'wire', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  check: 'Check',
  card: 'Card',
  ach: 'ACH',
  wire: 'Wire',
  other: 'Other',
};
