'use client';
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BankAccountDto,
  BankTransactionDto,
  BankTxnStatus,
  BulkReviewInput,
  BulkReviewResultDto,
  CategorizeInput,
  InboxPageDto,
  InvoiceCandidateDto,
  MatchCandidateDto,
  MatchInput,
  RecordInvoicePaymentInput,
  TransferInput,
} from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export interface InboxParams {
  bankAccountId?: string;
  status?: BankTxnStatus;
  from?: string;
  to?: string;
  q?: string;
  amountMin?: string;
  amountMax?: string;
  cursor?: string;
  limit?: number;
}

export type InboxPage = InboxPageDto & { counts: Partial<Record<BankTxnStatus, number>> };

export function bankAccountsOptions(companyId: string) {
  return queryOptions({
    queryKey: qk.banking.accounts(companyId),
    queryFn: ({ signal }) => api<BankAccountDto[]>('/api/banking/accounts', { companyId, signal }),
    staleTime: 60_000,
  });
}

export function useBankAccountsForInbox() {
  const { company } = useCompany();
  return useQuery(bankAccountsOptions(company.id));
}

export function inboxOptions(companyId: string, params: InboxParams) {
  return queryOptions({
    queryKey: qk.banking.inbox(companyId, params as Record<string, unknown>),
    queryFn: ({ signal }) => api<InboxPage>('/api/banking/transactions', { companyId, signal, query: params as Record<string, string | number | undefined> }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export function useInbox(params: InboxParams, opts: { enabled?: boolean } = {}) {
  const { company } = useCompany();
  return useQuery({ ...inboxOptions(company.id, params), enabled: opts.enabled ?? true });
}

export function useMatchCandidates(txnId: string | null) {
  const { company } = useCompany();
  return useQuery({
    queryKey: qk.banking.matchCandidates(company.id, txnId ?? ''),
    queryFn: ({ signal }) => api<MatchCandidateDto[]>(`/api/banking/transactions/${txnId}/candidates`, { companyId: company.id, signal }),
    enabled: Boolean(txnId),
    staleTime: 15_000,
  });
}

/** One bank line, for links that open it directly (`/banking/inbox?transactionId=`). */
export function useBankTransaction(id: string | null | undefined) {
  const { company } = useCompany();
  return useQuery({
    queryKey: qk.banking.transaction(company.id, id ?? ''),
    queryFn: ({ signal }) => api<BankTransactionDto>(`/api/banking/transactions/${id}`, { companyId: company.id, signal }),
    enabled: Boolean(id),
  });
}

/** Unpaid invoices a deposit could be paying, best first; `contactId` lists one customer's. */
export function useInvoiceCandidates(txnId: string | null, contactId: string | null, opts: { enabled?: boolean } = {}) {
  const { company } = useCompany();
  return useQuery({
    queryKey: [...qk.banking.matchCandidates(company.id, txnId ?? ''), 'invoices', contactId ?? 'any'] as const,
    queryFn: ({ signal }) =>
      api<InvoiceCandidateDto[]>(`/api/banking/transactions/${txnId}/invoices`, { companyId: company.id, signal, query: { contactId: contactId ?? undefined } }),
    enabled: Boolean(txnId) && (opts.enabled ?? true),
    staleTime: 15_000,
  });
}

function invalidateReview(qc: ReturnType<typeof useQueryClient>, companyId: string) {
  return Promise.all(
    [qk.banking.all(companyId), qk.purchases.all(companyId), qk.invoices.all(companyId), qk.payments.all(companyId), qk.contacts.all(companyId), ...postingAffectedKeys(companyId)].map((key) =>
      qc.invalidateQueries({ queryKey: key }),
    ),
  );
}

function useReviewMutation<TInput>(action: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: TInput }) =>
      api<BankTransactionDto>(`/api/banking/transactions/${id}/${action}`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (txn) => {
      qc.setQueryData(qk.banking.transaction(company.id, txn.id), txn);
      return invalidateReview(qc, company.id);
    },
  });
}

export function useCategorizeTransaction() {
  return useReviewMutation<CategorizeInput>('categorize');
}

export function useTransferTransaction() {
  return useReviewMutation<TransferInput>('transfer');
}

export function useMatchTransaction() {
  return useReviewMutation<MatchInput>('match');
}

/** "Customer paid an invoice": records the payment and matches the bank line in one step. */
export function useRecordInvoicePayment() {
  return useReviewMutation<RecordInvoicePaymentInput>('pay-invoice');
}

export function useExcludeTransaction() {
  return useReviewMutation<{ version: number; reason: string }>('exclude');
}

export function useUndoReview() {
  return useReviewMutation<{ version: number; reason?: string; idempotencyKey?: string }>('undo');
}

/** One action on many inbox lines; the result lists each line so partial failures can be shown. */
export function useBulkReview() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkReviewInput) => api<BulkReviewResultDto>('/api/banking/transactions/bulk', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () => invalidateReview(qc, company.id),
  });
}
