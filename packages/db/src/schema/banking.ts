import { pgTable, text, uuid, integer, boolean, date, numeric, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';

export const bankConnections = pgTable('bank_connections', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  provider: text({ enum: ['simplefin'] }).notNull(),
  name: text().notNull(),
  accessUrlCiphertext: text().notNull(),
  keyVersion: integer().notNull().default(1),
  status: text({ enum: ['active', 'error', 'revoked', 'disabled'] }).notNull().default('active'),
  syncIntervalMinutes: integer().notNull().default(360),
  nextSyncAt: timestamptz(),
  lastSyncStartedAt: timestamptz(),
  lastSuccessAt: timestamptz(),
  lastError: text(),
  lastErrorAt: timestamptz(),
  consecutiveFailures: integer().notNull().default(0),
  createdBy: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const bankAccounts = pgTable('bank_accounts', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  ledgerAccountId: uuid().notNull(),
  name: text().notNull(),
  kind: text({ enum: ['bank', 'credit_card'] }).notNull(),
  connectionId: uuid(),
  providerAccountId: text(),
  providerOrgName: text(),
  currency: text().notNull(),
  lastBalance: numeric({ precision: 20, scale: 6 }),
  lastBalanceAt: timestamptz(),
  lastSyncedAt: timestamptz(),
  isActive: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export interface CsvMappingJson {
  date: string;
  description: string;
  memo?: string | null;
  reference?: string | null;
  amounts: { amount?: string | null; debit?: string | null; credit?: string | null; invert?: boolean };
  dateOrder: 'YMD' | 'MDY' | 'DMY';
}

export const importBatches = pgTable('import_batches', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  bankAccountId: uuid().notNull(),
  source: text({ enum: ['csv', 'simplefin'] }).notNull(),
  fileAttachmentId: uuid(),
  fileName: text(),
  fileSha256: text(),
  mapping: jsonb().$type<CsvMappingJson | null>(),
  status: text({ enum: ['previewed', 'committed', 'discarded', 'failed'] }).notNull().default('previewed'),
  rowCount: integer().notNull().default(0),
  importedCount: integer().notNull().default(0),
  duplicateCount: integer().notNull().default(0),
  errorCount: integer().notNull().default(0),
  windowStart: date({ mode: 'string' }),
  windowEnd: date({ mode: 'string' }),
  error: text(),
  createdBy: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
  committedAt: timestamptz(),
});

export interface NormalizedImportRow {
  date: string;
  amount: string;
  description: string;
  memo: string | null;
  reference: string | null;
}

export const importRows = pgTable('import_rows', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  batchId: uuid().notNull(),
  rowNo: integer().notNull(),
  raw: jsonb().$type<Record<string, string>>().notNull(),
  normalized: jsonb().$type<NormalizedImportRow | null>(),
  fingerprint: text(),
  status: text({ enum: ['ok', 'duplicate', 'error'] }).notNull(),
  error: text(),
  duplicateOf: uuid(),
  bankTransactionId: uuid(),
});

export const BANK_TXN_STATUSES = ['unreviewed', 'categorized', 'matched', 'transfer', 'excluded'] as const;
export type BankTxnStatus = (typeof BANK_TXN_STATUSES)[number];

export const bankTransactions = pgTable('bank_transactions', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  bankAccountId: uuid().notNull(),
  source: text({ enum: ['csv', 'simplefin', 'manual'] }).notNull(),
  importBatchId: uuid(),
  providerTxnId: text(),
  fingerprint: text(),
  date: date({ mode: 'string' }).notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  currency: text().notNull(),
  description: text().notNull(),
  payee: text(),
  memo: text(),
  reference: text(),
  pending: boolean().notNull().default(false),
  status: text({ enum: BANK_TXN_STATUSES }).notNull().default('unreviewed'),
  excludedReason: text(),
  journalEntryId: uuid(),
  raw: jsonb().$type<Record<string, unknown> | null>(),
  firstSeenAt: timestamptz().notNull().default(sql`now()`),
  lastSeenAt: timestamptz().notNull().default(sql`now()`),
  changedAt: timestamptz(),
  changeNote: text(),
  reviewedBy: text(),
  reviewedAt: timestamptz(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

/** Bank lines deleted permanently; import and sync skip them so they stay gone. */
export const deletedBankTransactions = pgTable('deleted_bank_transactions', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  bankAccountId: uuid().notNull(),
  providerTxnId: text(),
  fingerprint: text(),
  date: date({ mode: 'string' }).notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  description: text().notNull(),
  deletedBy: text().notNull(),
  deletedAt: timestamptz().notNull().default(sql`now()`),
});

export const transactionMatches = pgTable('transaction_matches', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  bankTransactionId: uuid().notNull(),
  targetType: text({ enum: ['journal_entry', 'payment', 'purchase', 'refund', 'bank_transaction', 'processor_payout'] }).notNull(),
  targetId: uuid().notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  createdBy: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});

export const categorizationRules = pgTable('categorization_rules', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  name: text().notNull(),
  priority: integer().notNull().default(100),
  bankAccountId: uuid(),
  direction: text({ enum: ['any', 'in', 'out'] }).notNull().default('any'),
  matchField: text({ enum: ['description', 'payee', 'any'] }).notNull().default('description'),
  matchType: text({ enum: ['contains', 'starts_with', 'equals', 'regex'] }).notNull().default('contains'),
  pattern: text().notNull(),
  amountMin: numeric({ precision: 20, scale: 6 }),
  amountMax: numeric({ precision: 20, scale: 6 }),
  accountId: uuid().notNull(),
  contactId: uuid(),
  memo: text(),
  isActive: boolean().notNull().default(true),
  hitCount: integer().notNull().default(0),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const reconciliationSessions = pgTable('reconciliation_sessions', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  bankAccountId: uuid().notNull(),
  statementStartDate: date({ mode: 'string' }).notNull(),
  statementEndDate: date({ mode: 'string' }).notNull(),
  statementOpeningBalance: numeric({ precision: 20, scale: 6 }).notNull(),
  statementClosingBalance: numeric({ precision: 20, scale: 6 }).notNull(),
  status: text({ enum: ['in_progress', 'completed', 'flagged'] }).notNull().default('in_progress'),
  clearedBalance: numeric({ precision: 20, scale: 6 }),
  discrepancy: numeric({ precision: 20, scale: 6 }),
  completedAt: timestamptz(),
  completedBy: text(),
  flaggedReason: text(),
  flaggedAt: timestamptz(),
  notes: text(),
  createdBy: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const reconciliationItems = pgTable('reconciliation_items', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  sessionId: uuid().notNull(),
  journalLineId: uuid().notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});
