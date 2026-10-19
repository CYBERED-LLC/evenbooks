import { z } from 'zod';
import { DecimalString, IdempotencyKey, Pagination, PlainDateString, PositiveDecimalString, Uuid, sortParams } from './common';

export const PurchaseLineInput = z.object({
  accountId: Uuid,
  description: z.string().max(500).default(''),
  amount: PositiveDecimalString,
});
export type PurchaseLineInput = z.infer<typeof PurchaseLineInput>;

export const CreatePurchaseInput = z.object({
  date: PlainDateString,
  contactId: Uuid.nullable().optional(),
  /** Bank or credit-card ledger account the purchase was paid from. */
  paidFromAccountId: Uuid,
  direction: z.enum(['outflow', 'inflow']).default('outflow'),
  reference: z.string().max(100).nullable().optional(),
  memo: z.string().max(1000).nullable().optional(),
  lines: z.array(PurchaseLineInput).min(1).max(100),
  attachmentIds: z.array(Uuid).max(20).default([]),
  bankTransactionId: Uuid.nullable().optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type CreatePurchaseInput = z.infer<typeof CreatePurchaseInput>;

export const VoidPurchaseInput = z.object({
  version: z.number().int(),
  reason: z.string().min(1).max(500),
  date: PlainDateString.optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type VoidPurchaseInput = z.infer<typeof VoidPurchaseInput>;

export const PurchaseLineDto = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  accountId: z.string(),
  accountName: z.string().optional(),
  accountCode: z.string().optional(),
  description: z.string(),
  amount: DecimalString,
});

export const PurchaseDto = z.object({
  id: z.string(),
  date: PlainDateString,
  contactId: z.string().nullable(),
  contactName: z.string().nullable().optional(),
  direction: z.enum(['outflow', 'inflow']),
  paidFromAccountId: z.string(),
  paidFromAccountName: z.string().optional(),
  reference: z.string().nullable(),
  memo: z.string().nullable(),
  total: DecimalString,
  currency: z.string(),
  status: z.enum(['posted', 'void']),
  journalEntryId: z.string(),
  voidJournalEntryId: z.string().nullable(),
  bankTransactionId: z.string().nullable(),
  voidReason: z.string().nullable(),
  lines: z.array(PurchaseLineDto),
  attachments: z.array(z.object({ id: z.string(), fileName: z.string(), contentType: z.string(), sizeBytes: z.number() })).optional(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type PurchaseDto = z.infer<typeof PurchaseDto>;

export const PURCHASE_SORTS = ['date', 'total', 'vendor', 'reference'] as const;
export const ListPurchasesQuery = Pagination.extend({
  ...sortParams(PURCHASE_SORTS).shape,
  from: PlainDateString.optional(),
  to: PlainDateString.optional(),
  contactId: Uuid.optional(),
  accountId: Uuid.optional(),
  status: z.enum(['posted', 'void']).optional(),
  q: z.string().max(200).optional(),
});
export type ListPurchasesQuery = z.infer<typeof ListPurchasesQuery>;
