import type { InvoiceDesignSnapshot } from './invoice-presentation';
import { pgTable, pgEnum, text, uuid, integer, boolean, date, numeric, jsonb, bigserial } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';
import type { Address } from './foundation';

export const documentStatusEnum = pgEnum('document_status', ['draft', 'issued', 'paid', 'void']);

export interface CustomerSnapshot {
  name: string;
  email?: string | null;
  phone?: string | null;
  address?: Address;
}

export interface DiscountJson {
  type: 'percent' | 'fixed';
  value: string;
}

export interface LineTaxJson {
  taxRateId: string;
  name: string;
  rate: string;
  amount: string;
}

export interface TaxSummaryJson {
  taxRateId: string;
  name: string;
  rate: string;
  taxable: string;
  amount: string;
  liabilityAccountId: string;
}

const documentColumns = {
  currency: text().notNull(),
  customerSnapshot: jsonb().$type<CustomerSnapshot>().notNull().default({ name: '' }),
  documentDiscount: jsonb().$type<DiscountJson | null>(),
  subtotal: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  discountTotal: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  netTotal: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  taxTotal: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  total: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  taxSummary: jsonb().$type<TaxSummaryJson[]>().notNull().default([]),
};

export const invoices = pgTable('invoices', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  contactId: uuid().notNull(),
  number: text(),
  status: documentStatusEnum().notNull().default('draft'),
  ...documentColumns,
  issueDate: date({ mode: 'string' }).notNull(),
  dueDate: date({ mode: 'string' }).notNull(),
  termsDays: integer().notNull().default(30),
  memo: text(),
  footer: text(),
  paymentUrl: text(),
  onlinePaymentsDisabled: boolean().notNull().default(false),
  amountSettled: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  balanceDue: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  journalEntryId: uuid(),
  voidJournalEntryId: uuid(),
  recurringScheduleId: uuid(),
  recurringOccurrenceIndex: integer(),
  templateVersion: integer(),
  publicTokenHash: text(),
  publicTokenCiphertext: text(),
  publicTokenRevokedAt: timestamptz(),
  currentPdfAttachmentId: uuid(),
  designSnapshot: jsonb().$type<InvoiceDesignSnapshot>(),
  issuedAt: timestamptz(),
  issuedBy: text(),
  voidedAt: timestamptz(),
  voidedBy: text(),
  voidReason: text(),
  lastSentAt: timestamptz(),
  createdBy: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

const documentLineColumns = {
  lineNo: integer().notNull(),
  itemId: uuid(),
  description: text().notNull(),
  quantity: numeric({ precision: 20, scale: 6 }).notNull(),
  unitPrice: numeric({ precision: 20, scale: 6 }).notNull(),
  discount: jsonb().$type<DiscountJson | null>(),
  incomeAccountId: uuid().notNull(),
  taxRateIds: uuid().array().notNull().default([]),
  taxes: jsonb().$type<LineTaxJson[]>().notNull().default([]),
  gross: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  lineDiscount: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  documentDiscountShare: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  net: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  taxTotal: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  total: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
};

export const invoiceLines = pgTable('invoice_lines', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  invoiceId: uuid().notNull(),
  ...documentLineColumns,
});

export const invoicePdfs = pgTable('invoice_pdfs', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  invoiceId: uuid().notNull(),
  attachmentId: uuid().notNull(),
  version: integer().notNull(),
  reason: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});

export const creditNotes = pgTable('credit_notes', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  contactId: uuid().notNull(),
  invoiceId: uuid(),
  number: text(),
  status: documentStatusEnum().notNull().default('draft'),
  ...documentColumns,
  issueDate: date({ mode: 'string' }).notNull(),
  reason: text(),
  amountUsed: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  balance: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  journalEntryId: uuid(),
  voidJournalEntryId: uuid(),
  issuedAt: timestamptz(),
  issuedBy: text(),
  voidedAt: timestamptz(),
  voidReason: text(),
  createdBy: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const creditNoteLines = pgTable('credit_note_lines', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  creditNoteId: uuid().notNull(),
  ...documentLineColumns,
});

export const payments = pgTable('payments', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  contactId: uuid(),
  date: date({ mode: 'string' }).notNull(),
  currency: text().notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  method: text().notNull().default('other'),
  reference: text(),
  memo: text(),
  depositAccountId: uuid().notNull(),
  isRefundableDeposit: boolean().notNull().default(false),
  status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
  amountAllocated: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  amountRefunded: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  unappliedAmount: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
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

export const paymentAllocations = pgTable('payment_allocations', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  sourceType: text({ enum: ['payment', 'credit_note'] }).notNull(),
  paymentId: uuid(),
  creditNoteId: uuid(),
  invoiceId: uuid().notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  date: date({ mode: 'string' }).notNull(),
  journalEntryId: uuid(),
  status: text({ enum: ['active', 'reversed'] }).notNull().default('active'),
  reversalJournalEntryId: uuid(),
  reversedAt: timestamptz(),
  createdBy: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});

export const refunds = pgTable('refunds', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  contactId: uuid(),
  sourceType: text({ enum: ['payment', 'credit_note'] }).notNull(),
  paymentId: uuid(),
  creditNoteId: uuid(),
  date: date({ mode: 'string' }).notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  fromAccountId: uuid().notNull(),
  method: text().notNull().default('other'),
  reference: text(),
  memo: text(),
  status: text({ enum: ['posted', 'void'] }).notNull().default('posted'),
  journalEntryId: uuid().notNull(),
  voidJournalEntryId: uuid(),
  bankTransactionId: uuid(),
  createdBy: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});

export const RECOGNITION_KINDS = ['income', 'tax', 'expense', 'advance', 'other'] as const;
export type RecognitionKind = (typeof RECOGNITION_KINDS)[number];

export const cashRecognitions = pgTable('cash_recognitions', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  companyId: uuid().notNull(),
  date: date({ mode: 'string' }).notNull(),
  accountId: uuid().notNull(),
  amount: numeric({ precision: 20, scale: 6 }).notNull(),
  kind: text({ enum: RECOGNITION_KINDS }).notNull(),
  eventType: text().notNull(),
  eventId: uuid().notNull(),
  documentType: text(),
  documentId: uuid(),
  lineId: uuid(),
  taxRateId: uuid(),
  contactId: uuid(),
  journalEntryId: uuid(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});
