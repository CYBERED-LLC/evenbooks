'use client';
import { infiniteQueryOptions, keepPreviousData, queryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { qk } from '@/lib/query-keys';
import { useCompany } from '@/components/company-context';

export type ReportBasis = 'accrual' | 'cash';

export interface ReportLine {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

/** Mirrors `ProfitAndLoss` in packages/services/src/reports.ts. */
export interface ProfitAndLossReport {
  basis: ReportBasis;
  from: string;
  to: string;
  currency: string;
  income: ReportLine[];
  expenses: ReportLine[];
  totalIncome: string;
  totalExpenses: string;
  netIncome: string;
  /** Cash basis only: sales tax collected (a liability, not income). */
  salesTaxCollected?: string;
  note: string;
}

export interface ProfitAndLossParams {
  from: string;
  to: string;
  basis: ReportBasis;
}

export function profitAndLossOptions(companyId: string, params: ProfitAndLossParams) {
  // Fresh object literal so the key and query satisfy the Record index signatures.
  const query = { from: params.from, to: params.to, basis: params.basis };
  return queryOptions({
    queryKey: qk.reports.report(companyId, 'pnl', query),
    queryFn: ({ signal }) => api<ProfitAndLossReport>('/api/reports/profit-and-loss', { companyId, signal, query }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useProfitAndLoss(params: ProfitAndLossParams, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...profitAndLossOptions(company.id, params), enabled });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
type QueryParams = Record<string, string | number | boolean | undefined | null>;

/**
 * URL for the server-generated CSV of a report. Rows match the JSON exactly, so
 * the UI links to this with `<a download>` rather than building CSV client-side.
 */
/** URL of a report download in `format` (csv or pdf); empty params are dropped. */
export function reportDownloadUrl(path: string, params: QueryParams, format: 'csv' | 'pdf'): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  sp.set('format', format);
  return `${path}?${sp.toString()}`;
}

export function reportCsvUrl(path: string, params: QueryParams): string {
  return reportDownloadUrl(path, params, 'csv');
}

export function reportPdfUrl(path: string, params: QueryParams): string {
  return reportDownloadUrl(path, params, 'pdf');
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------
export interface BalanceSheetReport {
  asOf: string;
  currency: string;
  assets: ReportLine[];
  liabilities: ReportLine[];
  equity: ReportLine[];
  currentYearEarnings: string;
  retainedEarningsPriorYears: string;
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  /** assets − (liabilities + equity); "0.00" for a consistent ledger */
  difference: string;
  note: string;
}

export function balanceSheetOptions(companyId: string, params: { asOf: string }) {
  const query = { asOf: params.asOf };
  return queryOptions({
    queryKey: qk.reports.report(companyId, 'balance-sheet', query),
    queryFn: ({ signal }) => api<BalanceSheetReport>('/api/reports/balance-sheet', { companyId, signal, query }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useBalanceSheet(params: { asOf: string }, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...balanceSheetOptions(company.id, params), enabled });
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------
export type AccountTypeName = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountTypeName;
  firstEntryDate: string;
  debit: string;
  credit: string;
}

export interface TrialBalanceReport {
  asOf: string;
  currency: string;
  rows: TrialBalanceRow[];
  totalDebit: string;
  totalCredit: string;
  note: string;
}

export function trialBalanceOptions(companyId: string, params: { asOf: string }) {
  const query = { asOf: params.asOf };
  return queryOptions({
    queryKey: qk.reports.report(companyId, 'trial-balance', query),
    queryFn: ({ signal }) => api<TrialBalanceReport>('/api/reports/trial-balance', { companyId, signal, query }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useTrialBalance(params: { asOf: string }, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...trialBalanceOptions(company.id, params), enabled });
}

// ---------------------------------------------------------------------------
// General ledger (paged by offset cursor; "Load more" appends pages)
// ---------------------------------------------------------------------------
export interface GeneralLedgerLine {
  entryId: string;
  entryNumber: number | null;
  date: string;
  memo: string;
  lineMemo: string | null;
  sourceType: string;
  sourceId: string | null;
  contactId: string | null;
  debit: string;
  credit: string;
  running: string;
}

export interface GeneralLedgerReport {
  accountId: string;
  code: string;
  name: string;
  type: AccountTypeName;
  from: string;
  to: string;
  currency: string;
  opening: string;
  lines: GeneralLedgerLine[];
  closing: string;
  totalDebit: string;
  totalCredit: string;
  nextCursor: string | null;
  note: string;
}

export interface GeneralLedgerParams {
  accountId: string;
  from: string;
  to: string;
  limit?: number;
}

export function generalLedgerOptions(companyId: string, params: GeneralLedgerParams) {
  const query = { accountId: params.accountId, from: params.from, to: params.to, limit: params.limit ?? 100 };
  return infiniteQueryOptions({
    queryKey: qk.reports.report(companyId, 'general-ledger', query),
    queryFn: ({ signal, pageParam }) =>
      api<GeneralLedgerReport>('/api/reports/general-ledger', { companyId, signal, query: { ...query, cursor: pageParam || undefined } }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useGeneralLedger(params: GeneralLedgerParams, enabled = true) {
  const { company } = useCompany();
  return useInfiniteQuery({ ...generalLedgerOptions(company.id, params), enabled });
}

// ---------------------------------------------------------------------------
// Category report
// ---------------------------------------------------------------------------
export interface CategoryLine extends ReportLine {
  count: number;
}

export interface CategoryReport {
  basis: ReportBasis;
  from: string;
  to: string;
  currency: string;
  groups: { type: 'income' | 'expense'; lines: CategoryLine[]; total: string }[];
  uncategorized: { income: string; expense: string };
  netIncome: string;
  note: string;
}

export function categoryReportOptions(companyId: string, params: ProfitAndLossParams) {
  const query = { from: params.from, to: params.to, basis: params.basis };
  return queryOptions({
    queryKey: qk.reports.report(companyId, 'category', query),
    queryFn: ({ signal }) => api<CategoryReport>('/api/reports/category', { companyId, signal, query }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useCategoryReport(params: ProfitAndLossParams, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...categoryReportOptions(company.id, params), enabled });
}

// ---------------------------------------------------------------------------
// Schedule C summary
// ---------------------------------------------------------------------------
export type ScheduleCPart = 'income' | 'expense' | 'other';

export interface ScheduleCLine {
  code: string;
  label: string;
  part: ScheduleCPart | string;
  amount: string;
  accounts: ReportLine[];
  note?: string;
}

export interface ScheduleCReport {
  taxYear: number;
  basis: ReportBasis;
  currency: string;
  lines: ScheduleCLine[];
  unmapped: ReportLine[];
  /** Money still in the Uncategorized income/expense accounts and the line it lands on for now. */
  uncategorized: (ReportLine & { type: 'income' | 'expense'; lineCode: string | null; lineLabel: string | null })[];
  grossReceipts: string;
  totalExpenses: string;
  tentativeProfit: string;
  note: string;
}

export function scheduleCOptions(companyId: string, params: { taxYear: number; basis: ReportBasis }) {
  const query = { taxYear: params.taxYear, basis: params.basis };
  return queryOptions({
    queryKey: qk.reports.report(companyId, 'schedule-c', query),
    queryFn: ({ signal }) => api<ScheduleCReport>('/api/reports/schedule-c', { companyId, signal, query }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useScheduleC(params: { taxYear: number; basis: ReportBasis }, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...scheduleCOptions(company.id, params), enabled });
}

/**
 * Schedule C is the sole proprietor's form: it applies to sole proprietors,
 * single-member LLCs and companies that have not said what they are yet.
 */
export function scheduleCApplies(businessType: string | null | undefined): boolean {
  return !businessType || businessType === 'sole_proprietor' || businessType === 'single_member_llc';
}

// ---------------------------------------------------------------------------
// Bank transactions waiting for review (not in any report yet)
// ---------------------------------------------------------------------------
/** Mirrors `PendingReviewSummary` in packages/services/src/reports.ts. */
export interface PendingReview {
  from: string | null;
  to: string;
  currency: string;
  count: number;
  moneyIn: string;
  moneyOut: string;
}

/** `from` omitted: everything dated on or before `to` (for as-of reports). */
export function pendingReviewOptions(companyId: string, params: { from?: string; to: string }) {
  const query = { from: params.from || undefined, to: params.to };
  return queryOptions({
    queryKey: qk.reports.report(companyId, 'unreviewed', query),
    queryFn: ({ signal }) => api<PendingReview>('/api/reports/unreviewed', { companyId, signal, query }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function usePendingReview(params: { from?: string; to: string }, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...pendingReviewOptions(company.id, params), enabled });
}

// ---------------------------------------------------------------------------
// Transactions (paged)
// ---------------------------------------------------------------------------
export interface TransactionsRow {
  entryId: string;
  entryNumber: number | null;
  date: string;
  memo: string;
  lineMemo: string | null;
  sourceType: string;
  sourceId: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  contactId: string | null;
  contactName: string | null;
  debit: string;
  credit: string;
}

export interface TransactionsReport {
  from: string;
  to: string;
  currency: string;
  rows: TransactionsRow[];
  /** Over every matching line in the range, not just the loaded pages. */
  totalDebit: string;
  totalCredit: string;
  lineCount: number;
  nextCursor: string | null;
  note: string;
}

export interface TransactionsParams {
  from: string;
  to: string;
  accountId?: string;
  contactId?: string;
  sourceType?: string;
  /** Memo search (entry and line memo). */
  q?: string;
  limit?: number;
}

export function transactionsQuery(params: TransactionsParams) {
  return {
    from: params.from,
    to: params.to,
    accountId: params.accountId || undefined,
    contactId: params.contactId || undefined,
    sourceType: params.sourceType || undefined,
    q: params.q?.trim() || undefined,
    limit: params.limit ?? 100,
  };
}

export function transactionsOptions(companyId: string, params: TransactionsParams) {
  const query = transactionsQuery(params);
  return infiniteQueryOptions({
    queryKey: qk.reports.report(companyId, 'transactions', query),
    queryFn: ({ signal, pageParam }) =>
      api<TransactionsReport>('/api/reports/transactions', { companyId, signal, query: { ...query, cursor: pageParam || undefined } }),
    initialPageParam: '' as string,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useTransactionsReport(params: TransactionsParams, enabled = true) {
  const { company } = useCompany();
  return useInfiniteQuery({ ...transactionsOptions(company.id, params), enabled });
}

// ---------------------------------------------------------------------------
// Outstanding invoices (aging)
// ---------------------------------------------------------------------------
export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90plus';

export interface OutstandingInvoiceItem {
  id: string;
  number: string;
  contactId: string;
  contactName: string;
  issueDate: string;
  dueDate: string;
  total: string;
  balanceDue: string;
  daysOverdue: number;
  bucket: AgingBucket;
}

export interface OutstandingInvoicesReport {
  asOf: string;
  currency: string;
  items: OutstandingInvoiceItem[];
  aging: Record<AgingBucket, string>;
  total: string;
  note: string;
}

export function outstandingInvoicesOptions(companyId: string, params: { asOf?: string } = {}) {
  const query = { asOf: params.asOf || undefined };
  return queryOptions({
    queryKey: qk.reports.report(companyId, 'outstanding-invoices', query),
    queryFn: ({ signal }) => api<OutstandingInvoicesReport>('/api/reports/outstanding-invoices', { companyId, signal, query }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useOutstandingInvoices(params: { asOf?: string } = {}, enabled = true) {
  const { company } = useCompany();
  return useQuery({ ...outstandingInvoicesOptions(company.id, params), enabled });
}
