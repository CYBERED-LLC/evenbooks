import { pgTable, pgEnum, text, smallint, uuid, jsonb, integer, bigint, boolean, bigserial, date } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';

export const currencies = pgTable('currencies', {
  code: text().primaryKey(),
  minorUnits: smallint().notNull(),
  symbol: text().notNull(),
  name: text().notNull(),
});

export const accountTypeEnum = pgEnum('account_type', ['asset', 'liability', 'equity', 'income', 'expense']);

export const accountRoleEnum = pgEnum('account_role', [
  'accounts_receivable',
  'customer_deposits',
  'sales_tax_payable',
  'undeposited_funds',
  'bank',
  'credit_card',
  'opening_balance_equity',
  'owner_equity',
  'owner_draws',
  'retained_earnings',
  'sales_discounts',
  'bad_debt',
  'bank_fees',
  'uncategorized_income',
  'uncategorized_expense',
  'rounding',
  'advance_payments',
  'processor_clearing',
  'processor_fees',
]);

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export const companies = pgTable('companies', {
  id: uuid().primaryKey().defaultRandom(),
  clerkOrgId: text().notNull().unique(),
  name: text().notNull(),
  legalName: text(),
  email: text(),
  phone: text(),
  address: jsonb().$type<Address>().notNull().default({}),
  baseCurrency: text().notNull().default('USD'),
  timeZone: text().notNull().default('America/New_York'),
  fiscalYearStartMonth: smallint().notNull().default(1),
  invoicePrefix: text().notNull().default('INV-'),
  nextInvoiceNumber: integer().notNull().default(1),
  creditNotePrefix: text().notNull().default('CN-'),
  nextCreditNoteNumber: integer().notNull().default(1),
  nextJournalNumber: bigint({ mode: 'number' }).notNull().default(1),
  defaultTermsDays: integer().notNull().default(30),
  invoiceFooter: text(),
  settings: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  hasPostedEntries: boolean().notNull().default(false),
  plan: text({ enum: ['free', 'paid'] }).notNull().default('free'),
  transactionDeletionEnabled: boolean().notNull().default(true),
  businessType: text({ enum: ['sole_proprietor', 'single_member_llc', 'partnership', 's_corp', 'c_corp', 'nonprofit', 'other'] }),
  taxBasis: text({ enum: ['cash', 'accrual'] }),
  booksStartDate: date({ mode: 'string' }),
  setupDismissedAt: timestamptz(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const auditEvents = pgTable('audit_events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  companyId: uuid().notNull(),
  actorType: text({ enum: ['user', 'system', 'job'] }).notNull(),
  actorId: text().notNull(),
  action: text().notNull(),
  entityType: text().notNull(),
  entityId: text(),
  reason: text(),
  details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  requestId: text(),
  jobId: text(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  companyId: uuid().notNull(),
  key: text().notNull(),
  requestHash: text().notNull(),
  response: jsonb().$type<unknown>(),
  status: text({ enum: ['in_progress', 'completed'] }).notNull().default('in_progress'),
  createdAt: timestamptz().notNull().default(sql`now()`),
});
