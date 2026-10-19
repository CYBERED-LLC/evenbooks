import type { EmailContentSnapshot } from './invoice-presentation';
import { pgTable, text, uuid, integer, boolean, date, jsonb, bigserial } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';
import type { DiscountJson } from './sales';

export interface RecurringTemplateLine {
  itemId?: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discount?: DiscountJson | null;
  incomeAccountId: string;
  taxRateIds: string[];
}

export interface RecurringTemplate {
  lines: RecurringTemplateLine[];
  documentDiscount?: DiscountJson | null;
  memo?: string | null;
  footer?: string | null;
  /** Reusable payment URL (never copied from a single-use invoice link automatically). */
  paymentUrl?: string | null;
}

export const recurringSchedules = pgTable('recurring_schedules', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  contactId: uuid().notNull(),
  name: text().notNull(),
  status: text({ enum: ['active', 'paused', 'cancelled', 'completed'] }).notNull().default('active'),
  frequency: text({ enum: ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannually', 'yearly'] }).notNull(),
  anchorDate: date({ mode: 'string' }).notNull(),
  endDate: date({ mode: 'string' }),
  termsDays: integer().notNull().default(30),
  sendEmail: boolean().notNull().default(false),
  emailTo: text(),
  templateVersion: integer().notNull().default(1),
  template: jsonb().$type<RecurringTemplate>().notNull(),
  lastIssuedIndex: integer(),
  lastIssuedAt: timestamptz(),
  nextOccurrenceDate: date({ mode: 'string' }),
  nextRunAt: timestamptz(),
  pausedAt: timestamptz(),
  resumeFromIndex: integer(),
  createdFromInvoiceId: uuid(),
  createdBy: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const recurringTemplateVersions = pgTable('recurring_template_versions', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  scheduleId: uuid().notNull(),
  version: integer().notNull(),
  template: jsonb().$type<RecurringTemplate>().notNull(),
  createdBy: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
});

export const EMAIL_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'uncertain',
  'suppressed',
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const emailMessages = pgTable('email_messages', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  kind: text({ enum: ['invoice', 'invoice_test'] }).notNull(),
  invoiceId: uuid(),
  toEmail: text().notNull(),
  replyTo: text(),
  subject: text().notNull(),
  contentSnapshot: jsonb().$type<EmailContentSnapshot>(),
  templateVersion: integer(),
  status: text({ enum: EMAIL_STATUSES }).notNull().default('queued'),
  provider: text().notNull().default('ses'),
  providerMessageId: text(),
  attempts: integer().notNull().default(0),
  lastError: text(),
  isResend: boolean().notNull().default(false),
  requestedBy: text().notNull(),
  pdfAttachmentId: uuid(),
  dedupeKey: text(),
  queuedAt: timestamptz().notNull().default(sql`now()`),
  sentAt: timestamptz(),
  deliveredAt: timestamptz(),
  failedAt: timestamptz(),
  version: integer().notNull().default(1),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});

export const emailEvents = pgTable('email_events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  companyId: uuid(),
  emailMessageId: uuid(),
  provider: text().notNull(),
  providerMessageId: text(),
  eventType: text().notNull(),
  payload: jsonb().$type<Record<string, unknown>>().notNull(),
  occurredAt: timestamptz(),
  receivedAt: timestamptz().notNull().default(sql`now()`),
  providerEventId: text(),
});

export const emailSuppressions = pgTable('email_suppressions', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  email: text().notNull(),
  reason: text().notNull(),
  source: text().notNull().default('provider'),
  createdAt: timestamptz().notNull().default(sql`now()`),
});

export const outboxEvents = pgTable('outbox_events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  companyId: uuid().notNull(),
  eventType: text().notNull(),
  payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: text().notNull().unique(),
  createdAt: timestamptz().notNull().default(sql`now()`),
  dispatchedAt: timestamptz(),
  attempts: integer().notNull().default(0),
  lastError: text(),
});

export const taxFormMappings = pgTable('tax_form_mappings', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  form: text().notNull().default('schedule_c'),
  taxYear: integer().notNull(),
  accountId: uuid().notNull(),
  lineCode: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
  updatedAt: timestamptz().notNull().default(sql`now()`),
});
