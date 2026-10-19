import { z } from 'zod';
import { Address, NonNegativeDecimalString, Pagination, Uuid, QueryBoolean, sortParams } from './common';

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------
export const ContactDto = z.object({
  id: z.string(),
  name: z.string(),
  isCustomer: z.boolean(),
  isVendor: z.boolean(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  billingAddress: Address,
  notes: z.string().nullable(),
  isArchived: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type ContactDto = z.infer<typeof ContactDto>;

export const CreateContactInput = z
  .object({
    name: z.string().min(1).max(200),
    isCustomer: z.boolean().default(true),
    isVendor: z.boolean().default(false),
    email: z.email().nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    billingAddress: Address.optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .refine((c) => c.isCustomer || c.isVendor, { message: 'A contact must be a customer, a vendor, or both' });
export type CreateContactInput = z.infer<typeof CreateContactInput>;

export const UpdateContactInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).max(200).optional(),
  isCustomer: z.boolean().optional(),
  isVendor: z.boolean().optional(),
  email: z.email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  billingAddress: Address.optional(),
  notes: z.string().max(2000).nullable().optional(),
  isArchived: z.boolean().optional(),
});
export type UpdateContactInput = z.infer<typeof UpdateContactInput>;

/** Contact list sorts; the default is `name` A–Z (case-insensitive). */
export const CONTACT_SORTS = ['name', 'createdAt'] as const;
export type ContactSort = (typeof CONTACT_SORTS)[number];
export const ListContactsQuery = Pagination.extend({
  ...sortParams(CONTACT_SORTS).shape,
  q: z.string().max(200).optional(),
  kind: z.enum(['customer', 'vendor']).optional(),
  includeArchived: QueryBoolean.optional(),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuery>;

/** Archive or restore many contacts; `unarchive` is what "Undo" sends. Reversible metadata, so no idempotency key. */
export const BulkContactsInput = z.object({
  action: z.enum(['archive', 'unarchive']),
  items: z
    .array(z.object({ id: Uuid, version: z.number().int() }))
    .min(1)
    .max(100),
});
export type BulkContactsInput = z.infer<typeof BulkContactsInput>;

export const BulkContactsResultDto = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      ok: z.boolean(),
      contact: ContactDto.optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    }),
  ),
  succeeded: z.number().int(),
  failed: z.number().int(),
});
export type BulkContactsResultDto = z.infer<typeof BulkContactsResultDto>;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
export const ItemDto = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: z.enum(['service', 'product']),
  unitPrice: NonNegativeDecimalString,
  incomeAccountId: z.string(),
  defaultTaxRateIds: z.array(z.string()),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type ItemDto = z.infer<typeof ItemDto>;

export const CreateItemInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  kind: z.enum(['service', 'product']).default('service'),
  unitPrice: NonNegativeDecimalString.default('0'),
  incomeAccountId: Uuid,
  defaultTaxRateIds: z.array(Uuid).max(5).default([]),
});
export type CreateItemInput = z.infer<typeof CreateItemInput>;

export const UpdateItemInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  kind: z.enum(['service', 'product']).optional(),
  unitPrice: NonNegativeDecimalString.optional(),
  incomeAccountId: Uuid.optional(),
  defaultTaxRateIds: z.array(Uuid).max(5).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateItemInput = z.infer<typeof UpdateItemInput>;

// ---------------------------------------------------------------------------
// Tax rates
// ---------------------------------------------------------------------------
export const TaxRateDto = z.object({
  id: z.string(),
  name: z.string(),
  /** Decimal fraction, e.g. "0.0825". */
  rate: z.string(),
  agency: z.string().nullable(),
  liabilityAccountId: z.string(),
  isActive: z.boolean(),
  version: z.number().int(),
  /** Present when the list is requested with `withUsage=true`: active items defaulting to the rate, and issued unpaid invoices carrying it. */
  usage: z.object({ items: z.number().int(), openInvoices: z.number().int() }).optional(),
});
export type TaxRateDto = z.infer<typeof TaxRateDto>;

export const CreateTaxRateInput = z.object({
  name: z.string().min(1).max(100),
  rate: z.string().regex(/^0(\.\d{1,6})?$/, 'Rate must be a fraction between 0 and 1, e.g. 0.0825'),
  agency: z.string().max(200).nullable().optional(),
});
export type CreateTaxRateInput = z.infer<typeof CreateTaxRateInput>;

export const UpdateTaxRateInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).max(100).optional(),
  rate: z.string().regex(/^0(\.\d{1,6})?$/).optional(),
  agency: z.string().max(200).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateTaxRateInput = z.infer<typeof UpdateTaxRateInput>;
