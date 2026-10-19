'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeletableType, DeleteRecordInput, DeleteRecordResultDto, DeletionPreviewDto } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

const previewKey = (companyId: string, type: DeletableType, id: string) => [...qk.company(companyId), 'deletion-preview', type, id] as const;

/** What a permanent delete would remove and what blocks it. Admin only. */
export function useDeletionPreview(type: DeletableType, id: string, enabled: boolean) {
  const { company } = useCompany();
  return useQuery({
    queryKey: previewKey(company.id, type, id),
    queryFn: ({ signal }) => api<DeletionPreviewDto>('/api/deletions/preview', { companyId: company.id, signal, query: { type, id } }),
    enabled,
    staleTime: 0,
  });
}

/** Detail keys of the deleted record, removed so no page refetches a missing record. */
function detailKey(companyId: string, type: DeletableType, id: string) {
  switch (type) {
    case 'invoice': return qk.invoices.detail(companyId, id);
    case 'credit_note': return qk.creditNotes.detail(companyId, id);
    case 'payment': return qk.payments.detail(companyId, id);
    case 'purchase': return qk.purchases.detail(companyId, id);
    case 'journal_entry': return qk.journal.detail(companyId, id);
    case 'bank_transaction': return qk.banking.transaction(companyId, id);
    case 'refund': return null;
  }
}

const sameKey = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A delete can touch the ledger, documents, bank lines, reconciliations and
 * reports at once, so the whole company cache is refreshed afterwards. The
 * deleted record's own query is only marked stale: refetching it now would
 * swap the open page for "not found" before the caller navigates away.
 */
export function useDeleteRecord() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DeleteRecordInput) => api<DeleteRecordResultDto>('/api/deletions', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (_r, input) => {
      const key = detailKey(company.id, input.type, input.id);
      qc.removeQueries({ queryKey: previewKey(company.id, input.type, input.id) });
      if (key) void qc.invalidateQueries({ queryKey: key, exact: true, refetchType: 'none' });
      void qc.invalidateQueries({ queryKey: qk.company(company.id), predicate: (q) => !key || !sameKey(q.queryKey, key) });
    },
  });
}
