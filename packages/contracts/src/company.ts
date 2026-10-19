import { z } from 'zod';
import { Address, CurrencyCode } from './common';

export const BusinessType = z.enum(['sole_proprietor', 'single_member_llc', 'partnership', 's_corp', 'c_corp', 'nonprofit', 'other']);
export type BusinessType = z.infer<typeof BusinessType>;
export const TaxBasis = z.enum(['cash', 'accrual']);
export type TaxBasis = z.infer<typeof TaxBasis>;

export const CompanyDto = z.object({
  id: z.string(),
  clerkOrgId: z.string(),
  name: z.string(),
  legalName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: Address,
  baseCurrency: CurrencyCode,
  timeZone: z.string(),
  fiscalYearStartMonth: z.number().int(),
  invoicePrefix: z.string(),
  nextInvoiceNumber: z.number().int(),
  creditNotePrefix: z.string(),
  defaultTermsDays: z.number().int(),
  invoiceFooter: z.string().nullable(),
  hasPostedEntries: z.boolean(),
  /** Billing plan; drives the platform fee on online payments (free: percentage, paid: none). */
  plan: z.enum(['free', 'paid']),
  /** Admins may permanently delete posted records (as if they never existed). */
  transactionDeletionEnabled: z.boolean(),
  /** Setup answers; null until the owner answers. */
  businessType: BusinessType.nullable(),
  /** How the owner reports income tax; reports open on this basis. */
  taxBasis: TaxBasis.nullable(),
  /** First day of the books in Evenbooks (YYYY-MM-DD). */
  booksStartDate: z.string().nullable(),
  /** The dashboard setup checklist was dismissed. */
  setupDismissedAt: z.string().nullable(),
  version: z.number().int(),
});
export type CompanyDto = z.infer<typeof CompanyDto>;

export const UpdateCompanyInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).max(200).optional(),
  legalName: z.string().max(200).nullable().optional(),
  email: z.email().nullable().optional(),
  phone: z.string().max(50).nullable().optional(),
  address: Address.optional(),
  timeZone: z.string().min(1).optional(),
  /** 1 = January. Changeable only while no accounting period is closed. */
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  invoicePrefix: z.string().max(12).optional(),
  nextInvoiceNumber: z.number().int().positive().optional(),
  creditNotePrefix: z.string().max(12).optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
  invoiceFooter: z.string().max(2000).nullable().optional(),
  transactionDeletionEnabled: z.boolean().optional(),
  businessType: BusinessType.nullable().optional(),
  taxBasis: TaxBasis.nullable().optional(),
  booksStartDate: z.iso.date().nullable().optional(),
  /** true hides the setup checklist; false shows it again. */
  setupDismissed: z.boolean().optional(),
});
export type UpdateCompanyInput = z.infer<typeof UpdateCompanyInput>;

export const MembershipRole = z.enum(['admin', 'member']);
export type MembershipRole = z.infer<typeof MembershipRole>;

export const SessionDto = z.object({
  userId: z.string(),
  company: CompanyDto.nullable(),
  role: MembershipRole.nullable(),
  authMode: z.enum(['clerk', 'dev']),
  /** Members the company's plan allows. */
  memberLimit: z.number().int().nullable(),
  /** Server-wide capabilities the UI should hide when absent. */
  features: z.object({ onlinePayments: z.boolean(), stripeAccountLinking: z.boolean() }),
});
export type SessionDto = z.infer<typeof SessionDto>;
