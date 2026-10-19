import { pgTable, text, uuid, integer, boolean, numeric, jsonb, bigint } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';
import type { Address } from './foundation';

export const contacts = pgTable('contacts', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  name: text().notNull(),
  isCustomer: boolean().notNull().default(true),
  isVendor: boolean().notNull().default(false),
  email: text(),
  phone: text(),
  billingAddress: jsonb().$type<Address>().notNull().default({}),
  notes: text(),
  isArchived: boolean().notNull().default(false),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const taxRates = pgTable('tax_rates', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  name: text().notNull(),
  rate: numeric({ precision: 9, scale: 6 }).notNull(),
  agency: text(),
  liabilityAccountId: uuid().notNull(),
  isActive: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const items = pgTable('items', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  name: text().notNull(),
  description: text(),
  kind: text({ enum: ['service', 'product'] }).notNull().default('service'),
  unitPrice: numeric({ precision: 20, scale: 6 }).notNull().default('0'),
  incomeAccountId: uuid().notNull(),
  defaultTaxRateIds: uuid().array().notNull().default([]),
  isActive: boolean().notNull().default(true),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const ATTACHMENT_KINDS = ['receipt', 'invoice_pdf', 'csv_import', 'other'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const attachments = pgTable('attachments', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  kind: text({ enum: ATTACHMENT_KINDS }).notNull(),
  objectKey: text().notNull().unique(),
  fileName: text().notNull(),
  contentType: text().notNull(),
  sizeBytes: bigint({ mode: 'number' }).notNull(),
  sha256: text(),
  status: text({ enum: ['pending', 'uploaded', 'deleted'] }).notNull().default('pending'),
  entityType: text(),
  entityId: uuid(),
  uploadedBy: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
  completedAt: timestamptz(),
  deletedAt: timestamptz(),
});
