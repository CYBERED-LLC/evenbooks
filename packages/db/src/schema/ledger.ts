import { pgTable, pgEnum, text, uuid, integer, bigint, boolean, date, numeric, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';
import { accountTypeEnum, accountRoleEnum } from './foundation';

export const accounts = pgTable('accounts', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  code: text().notNull(),
  name: text().notNull(),
  type: accountTypeEnum().notNull(),
  role: accountRoleEnum(),
  parentId: uuid(),
  description: text(),
  currency: text().notNull(),
  isActive: boolean().notNull().default(true),
  isSystem: boolean().notNull().default(false),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const accountingPeriods = pgTable('accounting_periods', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  startDate: date({ mode: 'string' }).notNull(),
  endDate: date({ mode: 'string' }).notNull(),
  status: text({ enum: ['open', 'closed'] }).notNull().default('closed'),
  closedAt: timestamptz(),
  closedBy: text(),
  reopenedAt: timestamptz(),
  reopenedBy: text(),
  reason: text(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const journalStatusEnum = pgEnum('journal_status', ['draft', 'posted']);

export const JOURNAL_SOURCES = [
  'manual',
  'opening_balance',
  'invoice',
  'invoice_void',
  'credit_note',
  'credit_note_void',
  'payment',
  'payment_void',
  'allocation',
  'allocation_reversal',
  'refund',
  'refund_void',
  'purchase',
  'purchase_void',
  'transfer',
  'bank_categorization',
  'reversal',
  'adjustment',
  'processor_fee',
  'processor_payout',
  'import',
] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];
export const journalSourceEnum = pgEnum('journal_source', JOURNAL_SOURCES);

export const CASH_TREATMENTS = ['derived', 'include', 'exclude'] as const;
export type CashTreatment = (typeof CASH_TREATMENTS)[number];

export interface ImportCashComponent { accountId: string; amount: string; kind: 'income' | 'expense' }

export const journalEntries = pgTable('journal_entries', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  entryNumber: bigint({ mode: 'number' }),
  date: date({ mode: 'string' }).notNull(),
  memo: text().notNull().default(''),
  status: journalStatusEnum().notNull().default('draft'),
  sourceType: journalSourceEnum().notNull(),
  sourceId: uuid(),
  currency: text().notNull(),
  cashTreatment: text({ enum: CASH_TREATMENTS }).notNull(),
  cashComponents: jsonb().$type<ImportCashComponent[] | null>(),
  reversesEntryId: uuid(),
  reversedByEntryId: uuid(),
  postedAt: timestamptz(),
  postedBy: text(),
  createdBy: text().notNull(),
  idempotencyKey: text(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const journalLines = pgTable('journal_lines', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  entryId: uuid().notNull(),
  lineNo: integer().notNull(),
  accountId: uuid().notNull(),
  debit: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  credit: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  memo: text(),
  contactId: uuid(),
});
