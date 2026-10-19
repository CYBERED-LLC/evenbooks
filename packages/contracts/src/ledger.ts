import { ImportCashComponentInput } from './imports';
import { z } from 'zod';
import { DecimalString, IdempotencyKey, NonNegativeDecimalString, PlainDateString, Uuid, Pagination, sortParams } from './common';

export const AccountType = z.enum(['asset', 'liability', 'equity', 'income', 'expense']);
export type AccountType = z.infer<typeof AccountType>;

export const AccountRole = z.enum([
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
export type AccountRole = z.infer<typeof AccountRole>;

export const AccountDto = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  type: AccountType,
  role: AccountRole.nullable(),
  parentId: z.string().nullable(),
  description: z.string().nullable(),
  currency: z.string(),
  isActive: z.boolean(),
  isSystem: z.boolean(),
  version: z.number().int(),
  balance: DecimalString.optional(),
});
export type AccountDto = z.infer<typeof AccountDto>;

export const CreateAccountInput = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  type: AccountType,
  role: z.enum(['bank', 'credit_card', 'owner_equity', 'owner_draws']).nullable().optional(),
  parentId: Uuid.nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  /**
   * Income and expense accounts: the Schedule C line for the current tax year
   * (company time zone), saved with the account. `'excluded'` = not on Schedule C.
   */
  scheduleCLine: z.string().max(10).nullable().optional(),
});
export type CreateAccountInput = z.infer<typeof CreateAccountInput>;

export const UpdateAccountInput = z.object({
  version: z.number().int(),
  code: z.string().min(1).max(20).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  parentId: Uuid.nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateAccountInput = z.infer<typeof UpdateAccountInput>;

export const JournalStatus = z.enum(['draft', 'posted']);
export const CashTreatment = z.enum(['derived', 'include', 'exclude']);
export type CashTreatment = z.infer<typeof CashTreatment>;

export const JournalLineInput = z
  .object({
    accountId: Uuid,
    debit: NonNegativeDecimalString.optional(),
    credit: NonNegativeDecimalString.optional(),
    memo: z.string().max(500).nullable().optional(),
    contactId: Uuid.nullable().optional(),
  })
  .refine((l) => (l.debit && Number(l.debit) > 0) !== (l.credit && Number(l.credit) > 0), {
    message: 'Exactly one of debit or credit must be greater than zero',
  });
export type JournalLineInput = z.infer<typeof JournalLineInput>;

export const CreateManualJournalInput = z.object({
  date: PlainDateString,
  memo: z.string().max(1000).default(''),
  cashTreatment: z.enum(['include', 'exclude']),
  lines: z.array(JournalLineInput).min(2).max(200),
  post: z.boolean().default(false),
  idempotencyKey: IdempotencyKey.optional(),
});
export type CreateManualJournalInput = z.infer<typeof CreateManualJournalInput>;

export const UpdateDraftJournalInput = z.object({
  version: z.number().int(),
  date: PlainDateString.optional(),
  memo: z.string().max(1000).optional(),
  cashTreatment: z.enum(['include', 'exclude']).optional(),
  lines: z.array(JournalLineInput).min(2).max(200).optional(),
});
export type UpdateDraftJournalInput = z.infer<typeof UpdateDraftJournalInput>;

export const PostJournalInput = z.object({
  version: z.number().int(),
  idempotencyKey: IdempotencyKey.optional(),
});

export const ReverseJournalInput = z.object({
  date: PlainDateString,
  reason: z.string().min(1).max(1000),
  idempotencyKey: IdempotencyKey.optional(),
});
export type ReverseJournalInput = z.infer<typeof ReverseJournalInput>;

export const JournalLineDto = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  accountId: z.string(),
  accountCode: z.string().optional(),
  accountName: z.string().optional(),
  debit: DecimalString,
  credit: DecimalString,
  memo: z.string().nullable(),
  contactId: z.string().nullable(),
});
export type JournalLineDto = z.infer<typeof JournalLineDto>;

export const JournalEntryDto = z.object({
  id: z.string(),
  entryNumber: z.number().int().nullable(),
  date: PlainDateString,
  memo: z.string(),
  status: JournalStatus,
  sourceType: z.string(),
  sourceId: z.string().nullable(),
  currency: z.string(),
  cashTreatment: CashTreatment,
  cashComponents: z.array(ImportCashComponentInput).nullable(),
  reversesEntryId: z.string().nullable(),
  reversedByEntryId: z.string().nullable(),
  postedAt: z.string().nullable(),
  postedBy: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  version: z.number().int(),
  totalDebit: DecimalString,
  totalCredit: DecimalString,
  lines: z.array(JournalLineDto),
});
export type JournalEntryDto = z.infer<typeof JournalEntryDto>;

export const JOURNAL_SORTS = ['date', 'number'] as const;
export const ListJournalQuery = Pagination.extend({
  ...sortParams(JOURNAL_SORTS).shape,
  from: PlainDateString.optional(),
  to: PlainDateString.optional(),
  status: JournalStatus.optional(),
  accountId: Uuid.optional(),
  sourceType: z.string().optional(),
  q: z.string().max(200).optional(),
});
export type ListJournalQuery = z.infer<typeof ListJournalQuery>;

export const PeriodDto = z.object({
  id: z.string(),
  startDate: PlainDateString,
  endDate: PlainDateString,
  status: z.enum(['open', 'closed']),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenedBy: z.string().nullable(),
  reason: z.string().nullable(),
  version: z.number().int(),
});
export type PeriodDto = z.infer<typeof PeriodDto>;

export const ClosePeriodInput = z
  .object({
    startDate: PlainDateString,
    endDate: PlainDateString,
    reason: z.string().max(500).optional(),
  })
  .refine((p) => p.startDate <= p.endDate, { message: 'startDate must be on or before endDate' });
export type ClosePeriodInput = z.infer<typeof ClosePeriodInput>;

export const ReopenPeriodInput = z.object({
  version: z.number().int(),
  reason: z.string().min(1).max(500),
});
export type ReopenPeriodInput = z.infer<typeof ReopenPeriodInput>;

export const AuditEventDto = z.object({
  id: z.number(),
  actorType: z.enum(['user', 'system', 'job']),
  actorId: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  requestId: z.string().nullable(),
  jobId: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditEventDto = z.infer<typeof AuditEventDto>;

export const ListAuditQuery = Pagination.extend({
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  /** Inclusive calendar dates in the company's time zone. */
  from: PlainDateString.optional(),
  to: PlainDateString.optional(),
});

export const OpeningBalanceLineInput = z.object({
  accountId: Uuid,
  /** Balance in the account's natural direction (positive = debit for assets/expenses). */
  balance: DecimalString,
});

export const OpeningBalancesInput = z.object({
  date: PlainDateString,
  lines: z.array(OpeningBalanceLineInput).min(1).max(500),
  idempotencyKey: IdempotencyKey.optional(),
});
export type OpeningBalancesInput = z.infer<typeof OpeningBalancesInput>;

export const ReviewImportedCashInput = z.object({ version: z.number().int(), reason: z.string().trim().min(1).max(500), components: z.array(ImportCashComponentInput).max(200) });
export type ReviewImportedCashInput = z.infer<typeof ReviewImportedCashInput>;
