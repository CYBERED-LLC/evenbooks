'use client';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  BulkInvoiceInput,
  BulkInvoiceResultDto,
  CreateInvoiceInput,
  CustomerBalanceDto,
  Discount,
  DocumentLineDto,
  DocumentLineInput,
  EmailMessageDto,
  InvoiceDto,
  IssueInvoiceInput,
  ListInvoicesQuery,
  Page,
  SendInvoiceEmailInput,
  UpdateInvoiceInput,
  VoidInvoiceInput,
} from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type InvoiceListParams = Partial<ListInvoicesQuery>;

/** Server-side arithmetic for a document being edited; nothing is persisted. */
export interface PreviewInput {
  lines: DocumentLineInput[];
  documentDiscount?: Discount | null;
}
export type PreviewLine = Omit<DocumentLineDto, 'id' | 'lineNo' | 'itemId' | 'incomeAccountName'>;
export interface PreviewResult {
  lines: PreviewLine[];
  subtotal: string;
  discountTotal: string;
  netTotal: string;
  taxTotal: string;
  total: string;
  taxSummary: InvoiceDto['taxSummary'];
}

export interface PublicLinkResult {
  url: string | null;
  path: string | null;
}
export interface PdfVersionDto {
  version: number;
  attachmentId: string;
  reason: string;
  createdAt: string;
  sha256: string;
}
export interface PdfResult {
  attachmentId: string;
  downloadPath: string;
}

/** Booleans are coerced server-side (`"false"` would be truthy), so only send them when set. */
function listQuery(params: InvoiceListParams) {
  return {
    status: params.status,
    contactId: params.contactId,
    from: params.from,
    to: params.to,
    overdue: params.overdue ? true : undefined,
    outstanding: params.outstanding ? true : undefined,
    q: params.q,
    sort: params.sort,
    dir: params.dir,
    limit: params.limit,
    cursor: params.cursor,
  };
}

export function invoiceListOptions(companyId: string, params: InvoiceListParams) {
  return queryOptions({
    queryKey: qk.invoices.list(companyId, params),
    queryFn: ({ signal }) => api<Page<InvoiceDto>>('/api/invoices', { companyId, signal, query: listQuery(params) }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function invoiceDetailOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.invoices.detail(companyId, id),
    queryFn: ({ signal }) => api<InvoiceDto>(`/api/invoices/${id}`, { companyId, signal }),
  });
}

export function useInvoices(params: InvoiceListParams) {
  const { company } = useCompany();
  return useQuery(invoiceListOptions(company.id, params));
}

export function useInvoice(id: string, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...invoiceDetailOptions(company.id, id), enabled });
}

export function usePrefetchInvoice() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return (id: string) => void qc.prefetchQuery(invoiceDetailOptions(company.id, id));
}

/** Debounce the input in the caller; identical inputs hit the cache. */
export function useDocumentPreview(input: PreviewInput | null) {
  const { company } = useCompany();
  return useQuery({
    queryKey: [...qk.company(company.id), 'documentPreview', input] as const,
    queryFn: ({ signal }) => api<PreviewResult>('/api/invoices/preview', { method: 'POST', body: input, companyId: company.id, signal }),
    enabled: !!input && input.lines.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 60_000,
  });
}

export function useCustomerBalance(contactId: string | null | undefined) {
  const { company } = useCompany();
  return useQuery({
    queryKey: [...qk.contacts.all(company.id), 'balance', contactId ?? ''] as const,
    queryFn: ({ signal }) => api<CustomerBalanceDto>(`/api/contacts/${contactId}/balance`, { companyId: company.id, signal }),
    enabled: !!contactId,
    staleTime: 10_000,
  });
}

/** Invoices, credit notes and payments all move A/R, so a change to one refreshes them all. */
export function invalidateAfterSalesPosting(qc: QueryClient, companyId: string) {
  return Promise.all([
    ...postingAffectedKeys(companyId).map((key) => qc.invalidateQueries({ queryKey: key })),
    qc.invalidateQueries({ queryKey: qk.invoices.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.creditNotes.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.payments.all(companyId) }),
    qc.invalidateQueries({ queryKey: qk.contacts.all(companyId) }),
  ]);
}

export function useCreateInvoice() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInvoiceInput) => api<InvoiceDto>('/api/invoices', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (inv) => {
      qc.setQueryData(qk.invoices.detail(company.id, inv.id), inv);
      return qc.invalidateQueries({ queryKey: qk.invoices.all(company.id) });
    },
  });
}

/** Drafts accept the full input; issued invoices accept only `{ version, paymentUrl }`. */
export function useUpdateInvoice(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateInvoiceInput) => api<InvoiceDto>(`/api/invoices/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onSuccess: (inv) => {
      qc.setQueryData(qk.invoices.detail(company.id, id), inv);
      return qc.invalidateQueries({ queryKey: qk.invoices.all(company.id) });
    },
  });
}

export function useDeleteInvoice() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/invoices/${id}`, { method: 'DELETE', companyId: company.id }),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.invoices.detail(company.id, id) });
      return qc.invalidateQueries({ queryKey: qk.invoices.all(company.id) });
    },
  });
}

export function useIssueInvoice(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IssueInvoiceInput) => api<InvoiceDto>(`/api/invoices/${id}/issue`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (inv) => {
      qc.setQueryData(qk.invoices.detail(company.id, id), inv);
      return invalidateAfterSalesPosting(qc, company.id);
    },
  });
}

export function useVoidInvoice(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: VoidInvoiceInput) => api<InvoiceDto>(`/api/invoices/${id}/void`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (inv) => {
      qc.setQueryData(qk.invoices.detail(company.id, id), inv);
      return invalidateAfterSalesPosting(qc, company.id);
    },
  });
}

export function usePublicLink(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'get' | 'rotate' | 'revoke') =>
      api<PublicLinkResult>(`/api/invoices/${id}/public-link`, { method: 'POST', body: { action }, companyId: company.id }),
    onSuccess: (_r, action) => (action === 'get' ? undefined : qc.invalidateQueries({ queryKey: qk.invoices.detail(company.id, id) })),
  });
}

export function useInvoicePdfVersions(id: string, enabled = true) {
  const { company } = useCompany();
  return useQuery({
    queryKey: [...qk.invoices.detail(company.id, id), 'pdf'] as const,
    queryFn: ({ signal }) => api<PdfVersionDto[]>(`/api/invoices/${id}/pdf`, { companyId: company.id, signal }),
    enabled,
  });
}

export function useGenerateInvoicePdf(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (regenerate: boolean | 'apply-design') => api<PdfResult>(`/api/invoices/${id}/pdf`, { method: 'POST', body: { regenerate: regenerate === true, applyCurrentDesign: regenerate === 'apply-design' }, companyId: company.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.invoices.detail(company.id, id) }),
  });
}

const EMAIL_IN_FLIGHT = new Set(['queued', 'sending']);

/** Polls only while a message is still in flight; stops once every message reached a terminal state. */
export function useInvoiceEmails(id: string, enabled = true) {
  const { company } = useCompany();
  return useQuery({
    queryKey: qk.invoices.emails(company.id, id),
    queryFn: ({ signal }) => api<EmailMessageDto[]>(`/api/invoices/${id}/emails`, { companyId: company.id, signal }),
    enabled,
    refetchInterval: (query) => (query.state.data?.some((m) => EMAIL_IN_FLIGHT.has(m.status)) ? 4_000 : false),
  });
}

export function useSendInvoiceEmail(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendInvoiceEmailInput) => api<EmailMessageDto>(`/api/invoices/${id}/send`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: qk.invoices.emails(company.id, id) }),
        qc.invalidateQueries({ queryKey: qk.invoices.detail(company.id, id) }),
        qc.invalidateQueries({ queryKey: qk.audit.all(company.id) }),
      ]),
  });
}

/**
 * Issue or email many invoices (`POST /api/invoices/bulk`). Issuing posts to the
 * ledger, so every sales and posting key refreshes; sending only touches the
 * list (last sent) and each invoice's email log.
 */
export function useBulkInvoices() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkInvoiceInput) => api<BulkInvoiceResultDto>('/api/invoices/bulk', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (res) => {
      if (res.action === 'issue' && res.succeeded > 0) return invalidateAfterSalesPosting(qc, company.id);
      return qc.invalidateQueries({ queryKey: qk.invoices.all(company.id) });
    },
  });
}
