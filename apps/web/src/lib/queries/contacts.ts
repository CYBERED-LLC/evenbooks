'use client';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BulkContactsInput, BulkContactsResultDto, ContactDto, ContactSort, CreateContactInput, CustomerBalanceDto, InvoiceDto, Page, PaymentDto, PurchaseDto, UpdateContactInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type ContactListParams = {
  q?: string;
  kind?: 'customer' | 'vendor';
  includeArchived?: boolean;
  sort?: ContactSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
};

export function contactsListOptions(companyId: string, params: ContactListParams = {}) {
  return queryOptions({
    queryKey: qk.contacts.list(companyId, params),
    queryFn: ({ signal }) =>
      api<Page<ContactDto>>('/api/contacts', {
        companyId,
        signal,
        // `includeArchived` is coerced server-side, so only send it when true.
        query: { q: params.q, kind: params.kind, sort: params.sort, dir: params.dir, limit: params.limit, cursor: params.cursor, includeArchived: params.includeArchived ? true : undefined },
      }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function contactDetailOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.contacts.detail(companyId, id),
    queryFn: ({ signal }) => api<ContactDto>(`/api/contacts/${id}`, { companyId, signal }),
    staleTime: 30_000,
  });
}

export function useContacts(params: ContactListParams = {}) {
  const { company } = useCompany();
  return useQuery(contactsListOptions(company.id, params));
}

/** Pass an empty id to skip the request. */
export function useContact(id: string) {
  const { company } = useCompany();
  return useQuery({ ...contactDetailOptions(company.id, id), enabled: !!id });
}

export function usePrefetchContact() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return (id: string) => void qc.prefetchQuery(contactDetailOptions(company.id, id));
}

export function useCreateContact() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContactInput) => api<ContactDto>('/api/contacts', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (contact) => {
      qc.setQueryData(qk.contacts.detail(company.id, contact.id), contact);
      return qc.invalidateQueries({ queryKey: qk.contacts.all(company.id) });
    },
  });
}

/** Optimistic metadata edit (name, flags, address, archive) with rollback. */
export function useUpdateContact() {
  const { company } = useCompany();
  const qc = useQueryClient();
  const listPrefix = [...qk.contacts.all(company.id), 'list'] as const;
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateContactInput }) =>
      api<ContactDto>(`/api/contacts/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: qk.contacts.all(company.id) });
      const detailKey = qk.contacts.detail(company.id, id);
      const detailSnapshot = qc.getQueryData<ContactDto>(detailKey);
      const listSnapshots = qc.getQueriesData<Page<ContactDto>>({ queryKey: listPrefix });
      const patch = stripVersion(input);
      qc.setQueryData<ContactDto>(detailKey, (old) => (old ? { ...old, ...patch } : old));
      qc.setQueriesData<Page<ContactDto>>({ queryKey: listPrefix }, (old) =>
        old ? { ...old, items: old.items.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : old,
      );
      return { detailKey, detailSnapshot, listSnapshots };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      qc.setQueryData(ctx.detailKey, ctx.detailSnapshot);
      for (const [key, data] of ctx.listSnapshots) qc.setQueryData(key, data);
    },
    onSuccess: (contact) => {
      qc.setQueryData(qk.contacts.detail(company.id, contact.id), contact);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.contacts.all(company.id) }),
  });
}

/** Archive or restore many contacts (`POST /api/contacts/bulk`); "Undo" sends `unarchive` with the returned versions. */
export function useBulkContacts() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkContactsInput) => api<BulkContactsResultDto>('/api/contacts/bulk', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (res) => {
      for (const r of res.results) if (r.contact) qc.setQueryData(qk.contacts.detail(company.id, r.id), r.contact);
      return qc.invalidateQueries({ queryKey: qk.contacts.all(company.id) });
    },
  });
}

function stripVersion(input: UpdateContactInput): Partial<ContactDto> {
  const { version: _v, ...rest } = input;
  return rest as Partial<ContactDto>;
}

// ---------------------------------------------------------------------------
// Contact page: balance summary and per-contact activity
// ---------------------------------------------------------------------------

/** Open invoices, unapplied payments and credits for one customer. */
export function useContactBalance(contactId: string, enabled = true) {
  const { company } = useCompany();
  return useQuery({
    queryKey: [...qk.contacts.detail(company.id, contactId), 'balance'] as const,
    queryFn: ({ signal }) => api<CustomerBalanceDto>(`/api/contacts/${contactId}/balance`, { companyId: company.id, signal }),
    enabled: enabled && !!contactId,
    staleTime: 15_000,
  });
}

export type ContactActivityKind = 'invoices' | 'payments' | 'purchases';
type ActivityRow = { invoices: InvoiceDto; payments: PaymentDto; purchases: PurchaseDto };

const ACTIVITY_ROOT = {
  invoices: (c: string) => qk.invoices.all(c),
  payments: (c: string) => qk.payments.all(c),
  purchases: (c: string) => qk.purchases.all(c),
} as const;

/**
 * One page of a contact's invoices, payments or purchases. Keyed under each
 * document's own root so posting a document refreshes the contact page too.
 */
export function useContactActivity<K extends ContactActivityKind>(kind: K, contactId: string, opts: { cursor?: string; limit?: number; enabled?: boolean } = {}) {
  const { company } = useCompany();
  const { cursor, limit = 25, enabled = true } = opts;
  return useQuery({
    queryKey: [...ACTIVITY_ROOT[kind](company.id), 'byContact', contactId, { cursor, limit }] as const,
    queryFn: ({ signal }) => api<Page<ActivityRow[K]>>(`/api/${kind}`, { companyId: company.id, signal, query: { contactId, cursor, limit } }),
    enabled: enabled && !!contactId,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}
