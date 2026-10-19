import type { InvoicePdfData } from '@evenbooks/integrations';
import { pgTable, uuid, integer, text, jsonb, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { InvoicePresentation, InvoiceBranding } from '@evenbooks/domain';
import { timestamptz } from './columns';
export interface IssuerSnapshot {
  name: string;
  email: string | null;
  phone: string | null;
  address: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string };
}
export interface InvoiceDesignSnapshot {
  issuer: IssuerSnapshot;
  branding: InvoiceBranding;
  templateVersion: number;
}
export interface EmailContentSnapshot {
  from: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  senderIdentityId: string | null;
  logo: string | null;
  sample: boolean;
  pdfData?: InvoicePdfData;
}
export const invoicePresentationVersions = pgTable('invoice_presentation_versions', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  version: integer().notNull(),
  presentation: jsonb().$type<InvoicePresentation>().notNull(),
  createdBy: text().notNull(),
  createdAt: timestamptz()
    .notNull()
    .default(sql`now()`),
});
export const companyEmailSenders = pgTable('company_email_senders', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  domain: text().notNull(),
  fromEmail: text().notNull(),
  fromName: text().notNull(),
  proofToken: text().notNull(),
  dkimTokens: jsonb().$type<string[]>().notNull().default([]),
  status: text({ enum: ['pending', 'verified', 'failed', 'disabled'] })
    .notNull()
    .default('pending'),
  active: boolean().notNull().default(false),
  checkedAt: timestamptz(),
  lastError: text(),
  createdAt: timestamptz()
    .notNull()
    .default(sql`now()`),
});
