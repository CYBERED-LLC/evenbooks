'use client';
import * as React from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BankAccountDto, ReconciliationDetailDto, ReconciliationDto, StartReconciliationInput } from '@evenbooks/contracts';
import { api, ApiClientError } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

// ---------------------------------------------------------------------------
// Bank accounts (read-only here; the picker on the reconcile pages)
// ---------------------------------------------------------------------------
export function bankAccountsOptions(companyId: string) {
  return queryOptions({
    queryKey: qk.banking.accounts(companyId),
    queryFn: ({ signal }) => api<BankAccountDto[]>('/api/banking/accounts', { companyId, signal }),
    staleTime: 60_000,
  });
}

export function useBankAccounts() {
  const { company } = useCompany();
  return useQuery(bankAccountsOptions(company.id));
}

// ---------------------------------------------------------------------------
// Reconciliation sessions
// ---------------------------------------------------------------------------
/** Prefix matching every per-account and "all" reconciliations list. */
function reconciliationListPrefix(companyId: string) {
  return [...qk.banking.all(companyId), 'reconciliations'] as const;
}

export function reconciliationsOptions(companyId: string, bankAccountId?: string) {
  return queryOptions({
    queryKey: qk.banking.reconciliations(companyId, bankAccountId),
    queryFn: ({ signal }) => api<ReconciliationDto[]>('/api/banking/reconciliations', { companyId, signal, query: { bankAccountId } }),
    staleTime: 15_000,
  });
}

export function useReconciliations(bankAccountId?: string) {
  const { company } = useCompany();
  return useQuery(reconciliationsOptions(company.id, bankAccountId));
}

export function reconciliationOptions(companyId: string, id: string) {
  return queryOptions({
    queryKey: qk.banking.reconciliation(companyId, id),
    queryFn: ({ signal }) => api<ReconciliationDetailDto>(`/api/banking/reconciliations/${id}`, { companyId, signal }),
  });
}

export function useReconciliation(id: string) {
  const { company } = useCompany();
  return useQuery(reconciliationOptions(company.id, id));
}

type QC = ReturnType<typeof useQueryClient>;

/** Complete/reopen/delete change banking state and write audit rows. */
function invalidateStatusChange(qc: QC, companyId: string) {
  return Promise.all([qc.invalidateQueries({ queryKey: qk.banking.all(companyId) }), qc.invalidateQueries({ queryKey: qk.audit.all(companyId) })]);
}

export function useStartReconciliation() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StartReconciliationInput) =>
      api<ReconciliationDetailDto>('/api/banking/reconciliations', { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (detail) => {
      qc.setQueryData(qk.banking.reconciliation(company.id, detail.id), detail);
      return Promise.all([
        qc.invalidateQueries({ queryKey: reconciliationListPrefix(company.id) }),
        qc.invalidateQueries({ queryKey: qk.audit.all(company.id) }),
      ]);
    },
  });
}

/**
 * Clear/unclear statement lines without blocking the checkboxes. Toggles are
 * queued locally (`pending`: line id → wanted cleared state) and flushed in
 * batches, one request at a time; whatever is ticked while a request is in
 * flight goes out in the next batch. Setting a line's cleared state is
 * idempotent on the server, so a version conflict simply refetches and resends.
 * Anything still queued when the page unmounts is flushed on the way out.
 */
export function useReconciliationToggles(id: string, opts: { onError(err: unknown): void; delayMs?: number }) {
  const { company } = useCompany();
  const qc = useQueryClient();
  const companyId = company.id;
  const delay = opts.delayMs ?? 300;
  const queue = React.useRef(new Map<string, boolean>());
  const inFlight = React.useRef(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const onError = React.useRef(opts.onError);
  React.useEffect(() => {
    onError.current = opts.onError;
  });
  const [pending, setPending] = React.useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [saving, setSaving] = React.useState(false);

  const flush = React.useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    const key = qk.banking.reconciliation(companyId, id);
    const publish = () => setPending(new Map(queue.current));
    let conflicts = 0;
    try {
      while (queue.current.size > 0) {
        const detail = qc.getQueryData<ReconciliationDetailDto>(key);
        if (!detail) break;
        const server = new Map(detail.lines.map((l) => [l.journalLineId, l.cleared]));
        const batch = new Map(queue.current);
        const clear: string[] = [];
        const unclear: string[] = [];
        for (const [lineId, want] of batch) {
          if (!server.has(lineId) || server.get(lineId) === want) continue;
          (want ? clear : unclear).push(lineId);
        }
        const settle = () => {
          // Keep lines the user changed again while this batch was saving.
          for (const [lineId, want] of batch) if (queue.current.get(lineId) === want) queue.current.delete(lineId);
          publish();
        };
        if (clear.length === 0 && unclear.length === 0) {
          settle();
          continue;
        }
        try {
          const next = await api<ReconciliationDetailDto>(`/api/banking/reconciliations/${id}/items`, {
            method: 'POST',
            body: { version: detail.version, clear, unclear },
            companyId,
          });
          qc.setQueryData(key, next);
          settle();
        } catch (err) {
          if (err instanceof ApiClientError && err.code === 'version_conflict' && conflicts < 3) {
            conflicts += 1;
            await qc.refetchQueries({ queryKey: key, exact: true });
            continue;
          }
          queue.current.clear();
          publish();
          onError.current(err);
          void qc.invalidateQueries({ queryKey: key, exact: true });
          break;
        }
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [qc, companyId, id]);

  /** Queue lines to become cleared (true) or uncleared (false). */
  const set = React.useCallback(
    (changes: Iterable<readonly [string, boolean]>) => {
      for (const [lineId, want] of changes) queue.current.set(lineId, want);
      setPending(new Map(queue.current));
      if (inFlight.current) return; // the running flush picks these up
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), delay);
    },
    [flush, delay],
  );

  // Never drop ticks: save on unmount, and warn before closing the tab mid-save.
  React.useEffect(() => {
    const q = queue.current; // the same Map for the hook's lifetime
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (q.size > 0 || inFlight.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (q.size > 0) void flush();
    };
  }, [flush]);

  return { pending, saving: saving || pending.size > 0, set, flush };
}

export function useCompleteReconciliation(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: number; idempotencyKey: string }) =>
      api<ReconciliationDetailDto>(`/api/banking/reconciliations/${id}/complete`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (detail) => {
      qc.setQueryData(qk.banking.reconciliation(company.id, id), detail);
      return invalidateStatusChange(qc, company.id);
    },
    onError: (err) => {
      if (err instanceof ApiClientError && err.code === 'version_conflict') {
        return qc.invalidateQueries({ queryKey: qk.banking.reconciliation(company.id, id) });
      }
    },
  });
}

export function useReopenReconciliation(id: string) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { version: number; reason: string }) =>
      api<ReconciliationDetailDto>(`/api/banking/reconciliations/${id}/reopen`, { method: 'POST', body: input, companyId: company.id }),
    onSuccess: (detail) => {
      qc.setQueryData(qk.banking.reconciliation(company.id, id), detail);
      return invalidateStatusChange(qc, company.id);
    },
  });
}

export function useDeleteReconciliation() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/banking/reconciliations/${id}`, { method: 'DELETE', companyId: company.id }),
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: qk.banking.reconciliation(company.id, id) });
      return invalidateStatusChange(qc, company.id);
    },
  });
}
