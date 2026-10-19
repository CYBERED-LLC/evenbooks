'use client';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BankAccountDto, CreateBankAccountInput, CsvMapping, ImportBatchDto, JournalEntryDto, PreviewCsvInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------
export function bankAccountsOptions(companyId: string, params: { includeInactive?: boolean } = {}) {
  return queryOptions({
    queryKey: [...qk.banking.accounts(companyId), params] as const,
    queryFn: ({ signal }) => api<BankAccountDto[]>('/api/banking/accounts', { companyId, signal, query: params }),
    staleTime: 30_000,
  });
}

export function useBankAccounts(params: { includeInactive?: boolean } = {}) {
  const { company } = useCompany();
  return useQuery(bankAccountsOptions(company.id, params));
}

export function useCreateBankAccount() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBankAccountInput) => api<BankAccountDto>('/api/banking/accounts', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: () =>
      Promise.all([qc.invalidateQueries({ queryKey: qk.banking.accounts(company.id) }), qc.invalidateQueries({ queryKey: qk.accounts.all(company.id) })]),
  });
}

/**
 * Starting balance for one newly added bank account or card. Opening balances add to what is
 * already there, so this is only offered for an account that has just been created (balance 0).
 * Positive means money in the account, or owed on a card.
 */
export function usePostStartingBalance() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { accountId: string; balance: string; date: string; idempotencyKey: string }) =>
      api<JournalEntryDto>('/api/journal/opening-balances', {
        method: 'POST',
        body: { date: input.date, lines: [{ accountId: input.accountId, balance: input.balance }], idempotencyKey: input.idempotencyKey },
        companyId: company.id,
      }),
    // `company.hasPostedEntries` may flip, and the session key is not per-company.
    onSuccess: () =>
      Promise.all([
        ...postingAffectedKeys(company.id).map((key) => qc.invalidateQueries({ queryKey: key })),
        qc.invalidateQueries({ queryKey: qk.banking.accounts(company.id) }),
        qc.invalidateQueries({ queryKey: qk.session() }),
      ]),
  });
}

/** Rename / activate: reversible metadata, so updated optimistically with rollback. */
export function useUpdateBankAccount() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: { version: number; name?: string; isActive?: boolean } }) =>
      api<BankAccountDto>(`/api/banking/accounts/${id}`, { method: 'PATCH', body: input, companyId: company.id }),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: qk.banking.accounts(company.id) });
      const snapshots = qc.getQueriesData<BankAccountDto[]>({ queryKey: qk.banking.accounts(company.id) });
      const { version: _v, ...patch } = input;
      qc.setQueriesData<BankAccountDto[]>({ queryKey: qk.banking.accounts(company.id) }, (old) => old?.map((b) => (b.id === id ? { ...b, ...patch } : b)));
      return { snapshots };
    },
    onError: (_err, _vars, onMutateResult) => {
      for (const [key, data] of onMutateResult?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.banking.accounts(company.id) }),
  });
}

// ---------------------------------------------------------------------------
// CSV imports
// ---------------------------------------------------------------------------
export function importBatchesOptions(companyId: string, bankAccountId?: string) {
  return queryOptions({
    queryKey: qk.banking.batches(companyId, bankAccountId),
    queryFn: ({ signal }) => api<ImportBatchDto[]>('/api/banking/imports', { companyId, signal, query: { bankAccountId } }),
    staleTime: 15_000,
  });
}

export function useImportBatches(bankAccountId?: string, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...importBatchesOptions(company.id, bankAccountId), enabled });
}

export function importBatchOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.banking.batch(companyId, id),
    queryFn: ({ signal }) => api<ImportBatchDto>(`/api/banking/imports/${id}`, { companyId, signal }),
  });
}

export function useImportBatch(id: string | null) {
  const { company } = useCompany();
  return useQuery({ ...importBatchOptions(company.id, id ?? ''), enabled: Boolean(id) });
}

export function usePreviewCsv() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PreviewCsvInput) => api<ImportBatchDto>('/api/banking/imports', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (b) => {
      qc.setQueryData(qk.banking.batch(company.id, b.id), b);
      return qc.invalidateQueries({ queryKey: qk.banking.batches(company.id, b.bankAccountId) });
    },
  });
}

/** Re-parse with a different mapping. The server returns a NEW batch (new id). */
export function useRemapBatch() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mapping }: { id: string; mapping: CsvMapping }) =>
      api<ImportBatchDto>(`/api/banking/imports/${id}/remap`, { method: 'POST', body: mapping, companyId: company.id }),
    onSuccess: (b) => {
      qc.setQueryData(qk.banking.batch(company.id, b.id), b);
      return qc.invalidateQueries({ queryKey: qk.banking.batches(company.id, b.bankAccountId) });
    },
  });
}

export function useCommitBatch() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      api<ImportBatchDto>(`/api/banking/imports/${id}/commit`, { method: 'POST', body: { idempotencyKey }, companyId: company.id }),
    onSuccess: (b) => {
      qc.setQueryData(qk.banking.batch(company.id, b.id), b);
      return Promise.all([qc.invalidateQueries({ queryKey: qk.banking.all(company.id) }), qc.invalidateQueries({ queryKey: qk.audit.all(company.id) })]);
    },
  });
}

export function useDiscardBatch() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/banking/imports/${id}/discard`, { method: 'POST', companyId: company.id }),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.banking.batch(company.id, id) });
      return qc.invalidateQueries({ queryKey: [...qk.banking.all(company.id), 'batches'] });
    },
  });
}
