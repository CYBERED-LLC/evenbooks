/**
 * Central query-key factory. Every private key starts with ['company', companyId]
 * so a company switch can cancel/remove exactly that company's cache.
 */
export const qk = {
  company: (companyId: string) => ['company', companyId] as const,
  session: () => ['session'] as const,

  accounts: {
    all: (c: string) => [...qk.company(c), 'accounts'] as const,
    list: (c: string, params: { includeArchived?: boolean; withBalances?: boolean } = {}) =>
      [...qk.accounts.all(c), 'list', params] as const,
  },
  journal: {
    all: (c: string) => [...qk.company(c), 'journal'] as const,
    list: (c: string, params: Record<string, unknown>) => [...qk.journal.all(c), 'list', params] as const,
    detail: (c: string, id: string) => [...qk.journal.all(c), 'detail', id] as const,
  },
  periods: {
    all: (c: string) => [...qk.company(c), 'periods'] as const,
  },
  audit: {
    all: (c: string) => [...qk.company(c), 'audit'] as const,
    list: (c: string, params: Record<string, unknown>) => [...qk.audit.all(c), 'list', params] as const,
  },
  contacts: {
    all: (c: string) => [...qk.company(c), 'contacts'] as const,
    list: (c: string, params: Record<string, unknown>) => [...qk.contacts.all(c), 'list', params] as const,
    detail: (c: string, id: string) => [...qk.contacts.all(c), 'detail', id] as const,
  },
  items: {
    all: (c: string) => [...qk.company(c), 'items'] as const,
    list: (c: string, params: Record<string, unknown> = {}) => [...qk.items.all(c), 'list', params] as const,
  },
  taxRates: {
    all: (c: string) => [...qk.company(c), 'taxRates'] as const,
  },
  purchases: {
    all: (c: string) => [...qk.company(c), 'purchases'] as const,
    list: (c: string, params: Record<string, unknown>) => [...qk.purchases.all(c), 'list', params] as const,
    detail: (c: string, id: string) => [...qk.purchases.all(c), 'detail', id] as const,
  },
  attachments: {
    all: (c: string) => [...qk.company(c), 'attachments'] as const,
    forEntity: (c: string, entityType: string, entityId: string) => [...qk.attachments.all(c), entityType, entityId] as const,
  },
  banking: {
    all: (c: string) => [...qk.company(c), 'banking'] as const,
    accounts: (c: string) => [...qk.banking.all(c), 'accounts'] as const,
    connections: (c: string) => [...qk.banking.all(c), 'connections'] as const,
    inbox: (c: string, params: Record<string, unknown>) => [...qk.banking.all(c), 'inbox', params] as const,
    transaction: (c: string, id: string) => [...qk.banking.all(c), 'transaction', id] as const,
    batches: (c: string, bankAccountId?: string) => [...qk.banking.all(c), 'batches', bankAccountId ?? 'all'] as const,
    batch: (c: string, id: string) => [...qk.banking.all(c), 'batch', id] as const,
    rules: (c: string) => [...qk.banking.all(c), 'rules'] as const,
    reconciliations: (c: string, bankAccountId?: string) => [...qk.banking.all(c), 'reconciliations', bankAccountId ?? 'all'] as const,
    reconciliation: (c: string, id: string) => [...qk.banking.all(c), 'reconciliation', id] as const,
    matchCandidates: (c: string, txnId: string) => [...qk.banking.all(c), 'candidates', txnId] as const,
  },
  invoices: {
    all: (c: string) => [...qk.company(c), 'invoices'] as const,
    list: (c: string, params: Record<string, unknown>) => [...qk.invoices.all(c), 'list', params] as const,
    detail: (c: string, id: string) => [...qk.invoices.all(c), 'detail', id] as const,
    emails: (c: string, id: string) => [...qk.invoices.all(c), 'emails', id] as const,
  },
  creditNotes: {
    all: (c: string) => [...qk.company(c), 'creditNotes'] as const,
    list: (c: string, params: Record<string, unknown>) => [...qk.creditNotes.all(c), 'list', params] as const,
    detail: (c: string, id: string) => [...qk.creditNotes.all(c), 'detail', id] as const,
  },
  payments: {
    all: (c: string) => [...qk.company(c), 'payments'] as const,
    list: (c: string, params: Record<string, unknown>) => [...qk.payments.all(c), 'list', params] as const,
    detail: (c: string, id: string) => [...qk.payments.all(c), 'detail', id] as const,
    openForContact: (c: string, contactId: string) => [...qk.payments.all(c), 'open', contactId] as const,
  },
  recurring: {
    all: (c: string) => [...qk.company(c), 'recurring'] as const,
    detail: (c: string, id: string) => [...qk.recurring.all(c), 'detail', id] as const,
  },
  reports: {
    all: (c: string) => [...qk.company(c), 'reports'] as const,
    report: (c: string, name: string, params: Record<string, unknown>) => [...qk.reports.all(c), name, params] as const,
  },
  jobs: {
    all: (c: string) => [...qk.company(c), 'jobs'] as const,
    status: (c: string) => [...qk.jobs.all(c), 'status'] as const,
  },
  mappings: {
    all: (c: string) => [...qk.company(c), 'mappings'] as const,
    year: (c: string, year: number) => [...qk.mappings.all(c), year] as const,
  },
};

/** Keys that must be invalidated whenever a posting changes balances. */
export function postingAffectedKeys(companyId: string) {
  return [qk.accounts.all(companyId), qk.journal.all(companyId), qk.reports.all(companyId), qk.audit.all(companyId)];
}
