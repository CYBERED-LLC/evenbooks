import { pgTable, text, uuid, integer, date, numeric } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';

export const purchases = pgTable('purchases', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  contactId: uuid(),
  date: date({ mode: 'string' }).notNull(),
  currency: text().notNull(),
  direction: text({ enum: ['outflow', 'inflow'] }).notNull().default('outflow'),
  paidFromAccountId: uuid().notNull(),
  reference: text(),
  memo: text(),
  total: numeric({ precision: 20, scale: 6 }).notNull(),
  status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
  journalEntryId: uuid().notNull(),
  voidJournalEntryId: uuid(),
  bankTransactionId: uuid(),
  voidedAt: timestamptz(),
  voidReason: text(),
  createdBy: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const purchaseLines = pgTable('purchase_lines', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  purchaseId: uuid().notNull(),
  lineNo: integer().notNull(),
  accountId: uuid().notNull(),
  description: text().notNull().default(''),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
});
