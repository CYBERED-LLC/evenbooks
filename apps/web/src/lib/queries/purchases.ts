'use client';
import * as React from 'react';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AttachmentDto, CreatePurchaseInput, ListPurchasesQuery, Page, PurchaseDto, VoidPurchaseInput } from '@evenbooks/contracts';
import { api, ApiClientError } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type PurchaseListParams = Partial<ListPurchasesQuery>;

export function purchaseListOptions(companyId: string, params: PurchaseListParams) {
  return queryOptions({
    queryKey: qk.purchases.list(companyId, params),
    queryFn: ({ signal }) => api<Page<PurchaseDto>>('/api/purchases', { companyId, signal, query: params as Record<string, string | number | undefined> }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function purchaseDetailOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.purchases.detail(companyId, id),
    queryFn: ({ signal }) => api<PurchaseDto>(`/api/purchases/${id}`, { companyId, signal }),
  });
}

export function usePurchases(params: PurchaseListParams) {
  const { company } = useCompany();
  return useQuery(purchaseListOptions(company.id, params));
}

export function usePurchase(id: string) {
  const { company } = useCompany();
  return useQuery(purchaseDetailOptions(company.id, id));
}

export function usePrefetchPurchase() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return (id: string) => void qc.prefetchQuery(purchaseDetailOptions(company.id, id));
}

/**
 * The vendor's most recent purchase (or null), for prefilling "Paid from" and
 * the line account. Reuses the list endpoint: `?contactId=…&limit=1`.
 */
export function useFetchLatestPurchase() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return React.useCallback(
    async (contactId: string): Promise<PurchaseDto | null> => {
      const page = await qc.fetchQuery({ ...purchaseListOptions(company.id, { contactId, limit: 1 }), staleTime: 30_000 });
      return page.items[0] ?? null;
    },
    [qc, company.id],
  );
}

function invalidateAfterPosting(qc: ReturnType<typeof useQueryClient>, companyId: string) {
  return Promise.all([
    ...postingAffectedKeys(companyId).map((key) => qc.invalidateQueries({ queryKey: key })),
    qc.invalidateQueries({ queryKey: qk.purchases.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.banking.all(companyId) }),
  ]);
}

export function useCreatePurchase() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePurchaseInput) => api<PurchaseDto>('/api/purchases', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (p) => {
      qc.setQueryData(qk.purchases.detail(company.id, p.id), p);
      return invalidateAfterPosting(qc, company.id);
    },
  });
}

export function useVoidPurchase(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VoidPurchaseInput) => api<PurchaseDto>(`/api/purchases/${id}/void`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (p) => {
      qc.setQueryData(qk.purchases.detail(company.id, id), p);
      return invalidateAfterPosting(qc, company.id);
    },
  });
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
export function attachmentsForOptions(companyId: string, entityType: string, entityId: string) {
  return queryOptions({
    queryKey: qk.attachments.forEntity(companyId, entityType, entityId),
    queryFn: ({ signal }) => api<AttachmentDto[]>('/api/attachments', { companyId, signal, query: { entityType, entityId } }),
  });
}

export function useAttachmentsFor(entityType: string, entityId: string) {
  const { company } = useCompany();
  return useQuery(attachmentsForOptions(company.id, entityType, entityId));
}

/**
 * Multipart upload; the JSON api() helper cannot send FormData so this goes
 * through fetch directly with the same company header. With `link` the file is
 * attached to that saved record straight away; without it, pass the returned
 * id along when the record is created.
 */
export async function uploadAttachment(
  companyId: string,
  file: File,
  kind: 'receipt' | 'csv_import' | 'other' = 'receipt',
  link?: { entityType: 'purchase' | 'invoice' | 'journal_entry' | 'bank_transaction'; entityId: string },
): Promise<AttachmentDto> {
  const form = new FormData();
  form.append('file', file);
  form.append('kind', kind);
  if (link) {
    form.append('entityType', link.entityType);
    form.append('entityId', link.entityId);
  }
  const res = await fetch('/api/attachments', { method: 'POST', headers: { 'x-company-id': companyId }, body: form, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as { error?: { code: string; message: string; details?: unknown; requestId?: string } }) : undefined;
  if (!res.ok) {
    const e = data?.error;
    throw new ApiClientError(res.status, e?.code ?? 'http_error', e?.message ?? res.statusText, e?.details, e?.requestId);
  }
  return data as unknown as AttachmentDto;
}

/** "Attach receipt" on a saved expense: uploads the file onto the purchase and refreshes its receipts. */
export function useAttachReceipt(purchaseId: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadAttachment(company.id, file, 'receipt', { entityType: 'purchase', entityId: purchaseId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.attachments.forEntity(company.id, 'purchase', purchaseId) }),
  });
}

export function useDeleteAttachment(entityType: string, entityId: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/attachments/${id}`, { method: 'DELETE', companyId: company.id }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.attachments.forEntity(company.id, entityType, entityId) }),
        qc.invalidateQueries({ queryKey: qk.purchases.detail(company.id, entityId) }),
      ]),
  });
}
