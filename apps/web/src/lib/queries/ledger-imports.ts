'use client';
import * as React from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateLedgerImportInput, LedgerCsvMapping, LedgerImportDto, UpdateLedgerImportInput } from '@evenbooks/contracts';
import { api } from '@/lib/api-client';
import { postingAffectedKeys, qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

const keys = {
  all: (c: string) => [...qk.company(c), 'ledger-imports'] as const,
  list: (c: string) => [...keys.all(c), 'list'] as const,
  detail: (c: string, id: string) => [...keys.all(c), 'detail', id] as const,
};

export function ledgerImportsOptions(companyId: string) {
  return queryOptions({
    queryKey: keys.list(companyId),
    queryFn: ({ signal }) => api<LedgerImportDto[]>('/api/imports/ledger', { companyId, signal }),
    staleTime: 15_000,
  });
}

export function useLedgerImports() {
  const { company } = useCompany();
  return useQuery(ledgerImportsOptions(company.id));
}

export function useLedgerImport(id: string | null) {
  const { company } = useCompany();
  return useQuery({
    queryKey: keys.detail(company.id, id ?? ''),
    queryFn: ({ signal }) => api<LedgerImportDto>(`/api/imports/ledger/${id}`, { companyId: company.id, signal }),
    enabled: Boolean(id),
  });
}

/** Create, update and discard all return (or clear) the detailed preview for one import. */
function usePreviewMutation<TVars>(fn: (companyId: string, vars: TVars) => Promise<LedgerImportDto>) {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => fn(company.id, vars),
    onSuccess: (d) => {
      qc.setQueryData(keys.detail(company.id, d.id), d);
      return qc.invalidateQueries({ queryKey: keys.list(company.id) });
    },
  });
}

export function useCreateLedgerImport() {
  return usePreviewMutation((companyId, input: CreateLedgerImportInput) => api<LedgerImportDto>('/api/imports/ledger', { method: 'POST', body: input, companyId }));
}

export function useUpdateLedgerImport() {
  return usePreviewMutation((companyId, { id, input }: { id: string; input: UpdateLedgerImportInput }) =>
    api<LedgerImportDto>(`/api/imports/ledger/${id}`, { method: 'PATCH', body: input, companyId }),
  );
}

/**
 * Serial save queue for a previewed import. Column mapping and account choices
 * are applied optimistically (`pending` overlays the server's accountMap) and
 * sent one PATCH at a time, coalescing whatever changed while a request was in
 * flight, so pickers never lock and a later response can't be overwritten by
 * an earlier one.
 */
export function useLedgerImportChanges(id: string, { onError }: { onError: (err: unknown) => void }) {
  const { company } = useCompany();
  const qc = useQueryClient();
  const update = useUpdateLedgerImport();
  const { mutateAsync } = update;
  const queue = React.useRef<{ mapping?: LedgerCsvMapping; accountMap: Record<string, string | null> }>({ accountMap: {} });
  const running = React.useRef(false);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onErrorRef.current = onError;
  });
  const [pending, setPending] = React.useState<ReadonlyMap<string, string | null>>(() => new Map());
  const [inFlight, setInFlight] = React.useState(false);
  const [mappingPending, setMappingPending] = React.useState(false);

  const flush = React.useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setInFlight(true);
    try {
      while (queue.current.mapping || Object.keys(queue.current.accountMap).length > 0) {
        const sent = queue.current;
        queue.current = { accountMap: {} };
        const input: UpdateLedgerImportInput = {};
        if (sent.mapping) input.mapping = sent.mapping;
        if (Object.keys(sent.accountMap).length > 0) input.accountMap = sent.accountMap;
        try {
          await mutateAsync({ id, input });
        } catch (err) {
          queue.current = { accountMap: {} };
          setPending(new Map());
          setMappingPending(false);
          onErrorRef.current(err);
          await qc.invalidateQueries({ queryKey: keys.detail(company.id, id) });
          return;
        }
        if (sent.mapping && !queue.current.mapping) setMappingPending(false);
        // The server now has these choices; drop them from the overlay unless changed again since.
        setPending((prev) => {
          const next = new Map(prev);
          for (const [source, accountId] of Object.entries(sent.accountMap)) {
            if (next.get(source) === accountId && !(source in queue.current.accountMap)) next.delete(source);
          }
          return next;
        });
      }
    } finally {
      running.current = false;
      setInFlight(false);
    }
  }, [company.id, id, mutateAsync, qc]);

  const mapAccounts = React.useCallback(
    (changes: Record<string, string | null>) => {
      Object.assign(queue.current.accountMap, changes);
      setPending((prev) => {
        const next = new Map(prev);
        for (const [source, accountId] of Object.entries(changes)) next.set(source, accountId);
        return next;
      });
      void flush();
    },
    [flush],
  );

  const saveMapping = React.useCallback(
    (mapping: LedgerCsvMapping) => {
      queue.current.mapping = mapping;
      setMappingPending(true);
      void flush();
    },
    [flush],
  );

  const saving = inFlight || pending.size > 0 || mappingPending;
  React.useEffect(() => {
    if (!saving) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saving]);

  return { pending, saving, mappingPending, mapAccounts, saveMapping };
}

export function useCommitLedgerImport() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, idempotencyKey }: { id: string; idempotencyKey: string }) =>
      api<LedgerImportDto>(`/api/imports/ledger/${id}/commit`, { method: 'POST', body: { idempotencyKey }, companyId: company.id }),
    onSuccess: () =>
      // Balances change and `company.hasPostedEntries` may flip; the session key is not per-company.
      Promise.all([
        ...postingAffectedKeys(company.id).map((key) => qc.invalidateQueries({ queryKey: key })),
        qc.invalidateQueries({ queryKey: keys.all(company.id) }),
        qc.invalidateQueries({ queryKey: qk.session() }),
      ]),
  });
}

export function useDiscardLedgerImport() {
  const { company } = useCompany();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/imports/ledger/${id}/discard`, { method: 'POST', companyId: company.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all(company.id) }),
  });
}
