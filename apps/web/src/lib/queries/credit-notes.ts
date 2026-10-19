'use client';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApplyCreditNoteInput, CreateCreditNoteInput, CreditNoteDto, IssueCreditNoteInput, ListCreditNotesQuery, Page, RefundDto, VoidInvoiceInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';
import { invalidateAfterSalesPosting } from '@/lib/queries/invoices';

export type CreditNoteListParams = Partial<ListCreditNotesQuery>;
export type UpdateCreditNoteInput = Partial<CreateCreditNoteInput> & { version: number };

export function creditNoteListOptions(companyId: string, params: CreditNoteListParams) {
  return queryOptions({
    queryKey: qk.creditNotes.list(companyId, params),
    queryFn: ({ signal }) => api<Page<CreditNoteDto>>('/api/credit-notes', { companyId, signal, query: params as Record<string, string | number | undefined> }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function creditNoteDetailOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.creditNotes.detail(companyId, id),
    queryFn: ({ signal }) => api<CreditNoteDto>(`/api/credit-notes/${id}`, { companyId, signal }),
  });
}

export function useCreditNotes(params: CreditNoteListParams) {
  const { company } = useCompany();
  return useQuery(creditNoteListOptions(company.id, params));
}

export function useCreditNote(id: string) {
  const { company } = useCompany();
  return useQuery(creditNoteDetailOptions(company.id, id));
}

export function usePrefetchCreditNote() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return (id: string) => void qc.prefetchQuery(creditNoteDetailOptions(company.id, id));
}

export function useCreditNoteRefunds(creditNoteId: string, enabled = true) {
  const { company } = useCompany();
  return useQuery({
    queryKey: [...qk.creditNotes.detail(company.id, creditNoteId), 'refunds'] as const,
    queryFn: ({ signal }) => api<RefundDto[]>('/api/refunds', { companyId: company.id, signal, query: { creditNoteId } }),
    enabled,
  });
}

export function useCreateCreditNote() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCreditNoteInput) => api<CreditNoteDto>('/api/credit-notes', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (cn) => {
      qc.setQueryData(qk.creditNotes.detail(company.id, cn.id), cn);
      return qc.invalidateQueries({ queryKey: qk.creditNotes.all(company.id) });
    },
  });
}

export function useUpdateCreditNote(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateCreditNoteInput) => api<CreditNoteDto>(`/api/credit-notes/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onSuccess: (cn) => {
      qc.setQueryData(qk.creditNotes.detail(company.id, id), cn);
      return qc.invalidateQueries({ queryKey: qk.creditNotes.all(company.id) });
    },
  });
}

export function useDeleteCreditNote() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/credit-notes/${id}`, { method: 'DELETE', companyId: company.id }),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.creditNotes.detail(company.id, id) });
      return qc.invalidateQueries({ queryKey: qk.creditNotes.all(company.id) });
    },
  });
}

export function useIssueCreditNote(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueCreditNoteInput) => api<CreditNoteDto>(`/api/credit-notes/${id}/issue`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (cn) => {
      qc.setQueryData(qk.creditNotes.detail(company.id, id), cn);
      return invalidateAfterSalesPosting(qc, company.id);
    },
  });
}

export function useApplyCreditNote(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApplyCreditNoteInput) => api<CreditNoteDto>(`/api/credit-notes/${id}/apply`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (cn) => {
      qc.setQueryData(qk.creditNotes.detail(company.id, id), cn);
      return invalidateAfterSalesPosting(qc, company.id);
    },
  });
}

export function useVoidCreditNote(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VoidInvoiceInput) => api<CreditNoteDto>(`/api/credit-notes/${id}/void`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (cn) => {
      qc.setQueryData(qk.creditNotes.detail(company.id, id), cn);
      return invalidateAfterSalesPosting(qc, company.id);
    },
  });
}
