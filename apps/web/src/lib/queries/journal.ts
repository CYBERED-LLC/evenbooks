'use client';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateManualJournalInput, JournalEntryDto, ListJournalQuery, ReverseJournalInput, UpdateDraftJournalInput, Page } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type JournalListParams = Partial<ListJournalQuery>;

/** Every journal source type (mirrors `JOURNAL_SOURCES` in packages/db), with what it is in plain words. */
export const JOURNAL_SOURCE_LABELS: Record<string, string> = {
  manual: 'Manual entry',
  opening_balance: 'Starting balances',
  invoice: 'Invoice',
  invoice_void: 'Voided invoice',
  credit_note: 'Credit note',
  credit_note_void: 'Voided credit note',
  payment: 'Payment received',
  payment_void: 'Voided payment',
  allocation: 'Payment or credit applied',
  allocation_reversal: 'Payment unapplied',
  refund: 'Refund',
  refund_void: 'Voided refund',
  purchase: 'Expense',
  purchase_void: 'Voided expense',
  transfer: 'Transfer',
  bank_categorization: 'Bank transaction',
  reversal: 'Reversal',
  adjustment: 'Adjustment',
  processor_fee: 'Card processing fee',
  processor_payout: 'Card payout',
  import: 'Imported history',
};

export function journalSourceLabel(sourceType: string): string {
  return JOURNAL_SOURCE_LABELS[sourceType] ?? sourceType.charAt(0).toUpperCase() + sourceType.slice(1).replace(/_/g, ' ');
}

/** Whether an entry counts on cash-basis reports, in plain words (`derived`: follows its document). */
export const CASH_TREATMENT_LABEL: Record<string, string> = { include: 'Counts', exclude: 'Accrual only', derived: 'Automatic' };

/**
 * The page of the record an entry came from, when there is one: the invoice,
 * credit note, payment, expense or bank transaction. Allocations are left out:
 * their source id is a payment or a credit note and the entry doesn't say which.
 */
export function journalSourceHref(sourceType: string, sourceId: string | null | undefined): string | null {
  if (!sourceId) return null;
  switch (sourceType) {
    case 'invoice':
    case 'invoice_void':
      return `/invoices/${sourceId}`;
    case 'credit_note':
    case 'credit_note_void':
      return `/credit-notes/${sourceId}`;
    case 'payment':
    case 'payment_void':
    case 'allocation_reversal':
      return `/payments/${sourceId}`;
    case 'purchase':
    case 'purchase_void':
      return `/purchases/${sourceId}`;
    case 'transfer':
    case 'bank_categorization':
      return `/banking/inbox?transactionId=${sourceId}`;
    default:
      return null;
  }
}

export function journalListOptions(companyId: string, params: JournalListParams) {
  return queryOptions({
    queryKey: qk.journal.list(companyId, params),
    queryFn: ({ signal }) => api<Page<JournalEntryDto>>('/api/journal', { companyId, signal, query: params as Record<string, string | number | undefined> }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function journalDetailOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.journal.detail(companyId, id),
    queryFn: ({ signal }) => api<JournalEntryDto>(`/api/journal/${id}`, { companyId, signal }),
  });
}

export function useJournalList(params: JournalListParams) {
  const { company } = useCompany();
  return useQuery(journalListOptions(company.id, params));
}

/** Pass an empty id to skip the request. */
export function useJournalEntry(id: string) {
  const { company } = useCompany();
  return useQuery({ ...journalDetailOptions(company.id, id), enabled: !!id });
}

export function usePrefetchJournalEntry() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return (id: string) => void qc.prefetchQuery(journalDetailOptions(company.id, id));
}

function invalidatePosting(qc: ReturnType<typeof useQueryClient>, companyId: string) {
  return Promise.all(postingAffectedKeys(companyId).map((key) => qc.invalidateQueries({ queryKey: key })));
}

export function useCreateJournal() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateManualJournalInput) => api<JournalEntryDto>('/api/journal', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (entry) => {
      qc.setQueryData(qk.journal.detail(company.id, entry.id), entry);
      return invalidatePosting(qc, company.id);
    },
  });
}

export function useUpdateDraftJournal(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateDraftJournalInput) => api<JournalEntryDto>(`/api/journal/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onSuccess: (entry) => {
      qc.setQueryData(qk.journal.detail(company.id, id), entry);
      return qc.invalidateQueries({ queryKey: qk.journal.all(company.id) });
    },
  });
}

export function useDeleteDraftJournal() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/journal/${id}`, { method: 'DELETE', companyId: company.id }),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.journal.detail(company.id, id) });
      return qc.invalidateQueries({ queryKey: qk.journal.all(company.id) });
    },
  });
}

export function usePostJournal(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: number; idempotencyKey: string }) =>
      api<JournalEntryDto>(`/api/journal/${id}/post`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (entry) => {
      qc.setQueryData(qk.journal.detail(company.id, id), entry);
      return invalidatePosting(qc, company.id);
    },
  });
}

export function useReverseJournal(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReverseJournalInput) => api<JournalEntryDto>(`/api/journal/${id}/reverse`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (reversal) => {
      qc.setQueryData(qk.journal.detail(company.id, reversal.id), reversal);
      qc.invalidateQueries({ queryKey: qk.journal.detail(company.id, id) });
      return invalidatePosting(qc, company.id);
    },
  });
}

export function useReviewImportedCash(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: import('@evenbooks/contracts').ReviewImportedCashInput) => api<JournalEntryDto>(`/api/journal/${id}/cash-basis`, { method: 'PATCH', body: input, companyId: company.id }),
    onSuccess: entry => {
      qc.setQueryData(qk.journal.detail(company.id, id), entry);
      return invalidatePosting(qc, company.id);
    },
  });
}
