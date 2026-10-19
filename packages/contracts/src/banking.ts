import { z } from 'zod';
import { DecimalString, IdempotencyKey, NonNegativeDecimalString, Pagination, PlainDateString, PositiveDecimalString, Uuid } from './common';
import type { AccountDto } from './ledger';

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------
export const BankAccountDto = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['bank', 'credit_card']),
  ledgerAccountId: z.string(),
  ledgerAccountCode: z.string().optional(),
  ledgerAccountName: z.string().optional(),
  connectionId: z.string().nullable(),
  providerAccountId: z.string().nullable(),
  providerOrgName: z.string().nullable(),
  currency: z.string(),
  lastBalance: DecimalString.nullable(),
  lastBalanceAt: z.string().nullable(),
  lastSyncedAt: z.string().nullable(),
  ledgerBalance: DecimalString.optional(),
  unreviewedCount: z.number().int().optional(),
  isActive: z.boolean(),
  version: z.number().int(),
});
export type BankAccountDto = z.infer<typeof BankAccountDto>;

export const CreateBankAccountInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(['bank', 'credit_card']),
  /** Existing ledger account (role bank/credit_card) to link, or omit to create one. */
  ledgerAccountId: Uuid.optional(),
  newLedgerAccount: z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(120) }).optional(),
});
export type CreateBankAccountInput = z.infer<typeof CreateBankAccountInput>;

export const UpdateBankAccountInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------
export const CsvMapping = z.object({
  date: z.string().min(1),
  description: z.string().min(1),
  memo: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  amounts: z
    .object({
      amount: z.string().nullable().optional(),
      debit: z.string().nullable().optional(),
      credit: z.string().nullable().optional(),
      invert: z.boolean().optional(),
    })
    .refine((a) => Boolean(a.amount) || Boolean(a.debit) || Boolean(a.credit), { message: 'Map an amount column or debit/credit columns' }),
  dateOrder: z.enum(['YMD', 'MDY', 'DMY']).default('MDY'),
});
export type CsvMapping = z.infer<typeof CsvMapping>;

export const PreviewCsvInput = z.object({
  bankAccountId: Uuid,
  fileName: z.string().min(1).max(255),
  /** Raw CSV text (UTF-8). */
  content: z.string().min(1).max(5 * 1024 * 1024),
  mapping: CsvMapping.optional(),
});
export type PreviewCsvInput = z.infer<typeof PreviewCsvInput>;

export const ImportRowDto = z.object({
  rowNo: z.number().int(),
  status: z.enum(['ok', 'duplicate', 'error']),
  error: z.string().nullable(),
  date: PlainDateString.nullable(),
  amount: DecimalString.nullable(),
  description: z.string().nullable(),
  memo: z.string().nullable(),
  reference: z.string().nullable(),
  duplicateOf: z.string().nullable(),
  raw: z.record(z.string(), z.string()),
});
export type ImportRowDto = z.infer<typeof ImportRowDto>;

export const ImportBatchDto = z.object({
  id: z.string(),
  bankAccountId: z.string(),
  source: z.enum(['csv', 'simplefin']),
  fileName: z.string().nullable(),
  status: z.enum(['previewed', 'committed', 'discarded', 'failed']),
  mapping: CsvMapping.nullable(),
  headers: z.array(z.string()).optional(),
  rowCount: z.number().int(),
  importedCount: z.number().int(),
  duplicateCount: z.number().int(),
  errorCount: z.number().int(),
  windowStart: PlainDateString.nullable(),
  windowEnd: PlainDateString.nullable(),
  alreadyCommitted: z.boolean().optional(),
  createdAt: z.string(),
  committedAt: z.string().nullable(),
  rows: z.array(ImportRowDto).optional(),
});
export type ImportBatchDto = z.infer<typeof ImportBatchDto>;

export const CommitBatchInput = z.object({
  idempotencyKey: IdempotencyKey.optional(),
});

// ---------------------------------------------------------------------------
// Review inbox
// ---------------------------------------------------------------------------
export const BankTxnStatus = z.enum(['unreviewed', 'categorized', 'matched', 'transfer', 'excluded']);
export type BankTxnStatus = z.infer<typeof BankTxnStatus>;

export const BankTransactionDto = z.object({
  id: z.string(),
  bankAccountId: z.string(),
  bankAccountName: z.string().optional(),
  source: z.enum(['csv', 'simplefin', 'manual']),
  date: PlainDateString,
  amount: DecimalString,
  currency: z.string(),
  description: z.string(),
  payee: z.string().nullable(),
  memo: z.string().nullable(),
  reference: z.string().nullable(),
  pending: z.boolean(),
  status: BankTxnStatus,
  excludedReason: z.string().nullable(),
  journalEntryId: z.string().nullable(),
  changedAt: z.string().nullable(),
  changeNote: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  version: z.number().int(),
  suggestion: z
    .object({
      ruleId: z.string(),
      ruleName: z.string(),
      accountId: z.string(),
      accountName: z.string(),
      contactId: z.string().nullable(),
      memo: z.string().nullable(),
    })
    .nullable()
    .optional(),
  /**
   * Cheap hint for unreviewed rows in inbox lists: how many recorded ledger events
   * could match this line (same account, same amount, within 7 days) and the best
   * candidate's score (100 = same day, minus 5 per day apart), plus how many
   * opposite-amount lines in other bank accounts could be the other side of a transfer.
   */
  matchHint: z
    .object({
      count: z.number().int(),
      topScore: z.number(),
      transfers: z.number().int(),
      /** Money in on a bank account: open invoices whose balance equals this amount. */
      invoices: z.number().int(),
    })
    .nullable()
    .optional(),
});
export type BankTransactionDto = z.infer<typeof BankTransactionDto>;

export const ListInboxQuery = Pagination.extend({
  bankAccountId: Uuid.optional(),
  status: BankTxnStatus.optional(),
  from: PlainDateString.optional(),
  to: PlainDateString.optional(),
  /** Matches description, payee and memo; a number ("45", "$1,200.50") also matches the amount. */
  q: z.string().max(200).optional(),
  /** Absolute amount range (money in or out). */
  amountMin: NonNegativeDecimalString.optional(),
  amountMax: NonNegativeDecimalString.optional(),
});
export type ListInboxQuery = z.infer<typeof ListInboxQuery>;

export const InboxPageDto = z.object({
  items: z.array(BankTransactionDto),
  nextCursor: z.string().nullable(),
  /** Rows per status for the current bank account, search, date and amount filters (status and paging ignored). */
  counts: z.record(z.string(), z.number().int()),
  /** Unreviewed rows (same filters) that a rule has a suggestion for. */
  suggestedCount: z.number().int(),
});
export type InboxPageDto = z.infer<typeof InboxPageDto>;

export const MatchCandidateDto = z.object({
  targetType: z.enum(['payment', 'purchase', 'refund', 'journal_entry', 'bank_transaction', 'processor_payout']),
  targetId: z.string(),
  date: PlainDateString,
  amount: DecimalString,
  description: z.string(),
  detail: z.string().nullable(),
  /** for bank_transaction candidates (transfers) */
  bankAccountName: z.string().nullable().optional(),
  /** A customer payment still waiting in Undeposited Funds; several can add up to one deposit. */
  undeposited: z.boolean().optional(),
  score: z.number(),
});
export type MatchCandidateDto = z.infer<typeof MatchCandidateDto>;

/** An unpaid invoice that a deposit could be paying. */
export const InvoiceCandidateDto = z.object({
  invoiceId: z.string(),
  number: z.string(),
  contactId: z.string(),
  contactName: z.string(),
  issueDate: PlainDateString,
  dueDate: PlainDateString,
  total: DecimalString,
  balanceDue: DecimalString,
  isOverdue: z.boolean(),
  /** exact: the balance equals the deposit; customer: the chosen or recognized customer; close: a similar amount. */
  reason: z.enum(['exact', 'customer', 'close']),
  score: z.number(),
});
export type InvoiceCandidateDto = z.infer<typeof InvoiceCandidateDto>;

export const InvoiceCandidatesQuery = z.object({
  /** Only this customer's open invoices (any amount). */
  contactId: Uuid.optional(),
});
export type InvoiceCandidatesQuery = z.infer<typeof InvoiceCandidatesQuery>;

/**
 * "Customer paid an invoice": record a customer payment for this deposit and
 * match the bank line to it in one step. The deposit pays the invoices in due
 * date order; anything left over stays as credit for the customer.
 */
export const RecordInvoicePaymentInput = z.object({
  version: z.number().int(),
  invoiceIds: z.array(Uuid).min(1).max(20),
  idempotencyKey: IdempotencyKey.optional(),
});
export type RecordInvoicePaymentInput = z.infer<typeof RecordInvoicePaymentInput>;

export const CategorizeInput = z.object({
  version: z.number().int(),
  contactId: Uuid.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  lines: z
    .array(
      z.object({
        accountId: Uuid,
        amount: PositiveDecimalString,
        description: z.string().max(500).default(''),
      }),
    )
    .min(1)
    .max(50),
  /** Save a categorization rule from this decision. */
  createRule: z
    .object({
      pattern: z.string().min(1).max(200),
      matchType: z.enum(['contains', 'starts_with', 'equals']).default('contains'),
      /** Defaults to this transaction's direction (money in or out). */
      direction: z.enum(['any', 'in', 'out']).optional(),
    })
    .optional(),
  /** Uploaded receipts to link to the record this creates. */
  attachmentIds: z.array(Uuid).max(20).optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type CategorizeInput = z.infer<typeof CategorizeInput>;

/** Shared by the transfer picker and posting validation, including custom clearing assets. */
export function isTransferAccount(account: Pick<AccountDto, 'type' | 'role'>): boolean {
  if (account.type === 'asset') {
    return account.role === null || account.role === 'bank' || account.role === 'undeposited_funds' || account.role === 'processor_clearing';
  }
  if (account.type === 'liability') {
    return account.role !== 'customer_deposits' && account.role !== 'sales_tax_payable';
  }
  return account.role === 'owner_equity' || account.role === 'owner_draws';
}

export const TransferInput = z
  .object({
    version: z.number().int(),
    /** The other side, if already imported. */
    counterpartTransactionId: Uuid.optional(),
    /** Or another transfer-eligible ledger account, including a clearing asset. */
    otherLedgerAccountId: Uuid.optional(),
    memo: z.string().max(500).nullable().optional(),
    idempotencyKey: IdempotencyKey.optional(),
  })
  .refine((t) => Boolean(t.counterpartTransactionId) !== Boolean(t.otherLedgerAccountId), {
    message: 'Provide either a counterpart transaction or another ledger account',
  });
export type TransferInput = z.infer<typeof TransferInput>;

export const MatchInput = z.object({
  version: z.number().int(),
  targets: z
    .array(
      z.object({
        targetType: z.enum(['payment', 'purchase', 'refund', 'journal_entry', 'processor_payout']),
        targetId: Uuid,
      }),
    )
    .min(1)
    .max(50),
  /** Bank/processor fee explaining a smaller net deposit. */
  fee: z.object({ amount: PositiveDecimalString, accountId: Uuid }).optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type MatchInput = z.infer<typeof MatchInput>;

export const ExcludeInput = z.object({
  version: z.number().int(),
  reason: z.string().min(1).max(500),
});

export const UndoReviewInput = z.object({
  version: z.number().int(),
  reason: z.string().max(500).optional(),
  idempotencyKey: IdempotencyKey.optional(),
});

/**
 * Review many inbox lines at once. Each item runs in its own savepoint, so one
 * failure (stale version, closed period) does not undo the others; the result
 * lists every item. The idempotency key covers the whole request.
 */
const BulkItems = z
  .array(z.object({ id: Uuid, version: z.number().int() }))
  .min(1)
  .max(100);
export const BulkReviewInput = z.discriminatedUnion('action', [
  /** Categorize each line to the account its matching rule suggests (evaluated on the server). */
  z.object({ action: z.literal('accept_suggestion'), items: BulkItems, idempotencyKey: IdempotencyKey.optional() }),
  z.object({
    action: z.literal('categorize'),
    items: BulkItems,
    accountId: Uuid,
    contactId: Uuid.nullable().optional(),
    memo: z.string().max(500).nullable().optional(),
    idempotencyKey: IdempotencyKey.optional(),
  }),
  /** Record each line as a separate transfer against one explicitly chosen ledger account. */
  z.object({
    action: z.literal('transfer'),
    items: BulkItems,
    otherLedgerAccountId: Uuid,
    idempotencyKey: IdempotencyKey.optional(),
  }),
  z.object({ action: z.literal('exclude'), items: BulkItems, reason: z.string().min(1).max(500), idempotencyKey: IdempotencyKey.optional() }),
  /** Put reviewed lines back in the inbox (used by "Undo" after a bulk action). */
  z.object({ action: z.literal('undo'), items: BulkItems, reason: z.string().max(500).optional(), idempotencyKey: IdempotencyKey.optional() }),
]);
export type BulkReviewInput = z.infer<typeof BulkReviewInput>;

export const BulkReviewItemResult = z.object({
  id: z.string(),
  ok: z.boolean(),
  transaction: BankTransactionDto.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type BulkReviewItemResult = z.infer<typeof BulkReviewItemResult>;

export const BulkReviewResultDto = z.object({
  results: z.array(BulkReviewItemResult),
  succeeded: z.number().int(),
  failed: z.number().int(),
});
export type BulkReviewResultDto = z.infer<typeof BulkReviewResultDto>;

export const CreateManualBankTransactionInput = z.object({
  bankAccountId: Uuid,
  date: PlainDateString,
  amount: DecimalString,
  description: z.string().min(1).max(500),
  memo: z.string().max(500).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Categorization rules
// ---------------------------------------------------------------------------
export const RuleDto = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.number().int(),
  bankAccountId: z.string().nullable(),
  direction: z.enum(['any', 'in', 'out']),
  matchField: z.enum(['description', 'payee', 'any']),
  matchType: z.enum(['contains', 'starts_with', 'equals', 'regex']),
  pattern: z.string(),
  amountMin: DecimalString.nullable(),
  amountMax: DecimalString.nullable(),
  accountId: z.string(),
  accountName: z.string().optional(),
  contactId: z.string().nullable(),
  memo: z.string().nullable(),
  isActive: z.boolean(),
  hitCount: z.number().int(),
  version: z.number().int(),
});
export type RuleDto = z.infer<typeof RuleDto>;

export const CreateRuleInput = z.object({
  name: z.string().min(1).max(120),
  priority: z.number().int().min(1).max(10000).default(100),
  bankAccountId: Uuid.nullable().optional(),
  direction: z.enum(['any', 'in', 'out']).default('any'),
  matchField: z.enum(['description', 'payee', 'any']).default('description'),
  matchType: z.enum(['contains', 'starts_with', 'equals']).default('contains'),
  pattern: z.string().min(1).max(200),
  amountMin: PositiveDecimalString.nullable().optional(),
  amountMax: PositiveDecimalString.nullable().optional(),
  accountId: Uuid,
  contactId: Uuid.nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});
export type CreateRuleInput = z.infer<typeof CreateRuleInput>;

export const UpdateRuleInput = CreateRuleInput.omit({ priority: true, direction: true, matchField: true, matchType: true }).partial().extend({
  priority: z.number().int().min(1).max(10000).optional(),
  direction: z.enum(['any', 'in', 'out']).optional(),
  matchField: z.enum(['description', 'payee', 'any']).optional(),
  matchType: z.enum(['contains', 'starts_with', 'equals']).optional(),
  version: z.number().int(),
  isActive: z.boolean().optional(),
});
export type UpdateRuleInput = z.infer<typeof UpdateRuleInput>;

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------
export const ReconciliationDto = z.object({
  id: z.string(),
  bankAccountId: z.string(),
  bankAccountName: z.string().optional(),
  statementStartDate: PlainDateString,
  statementEndDate: PlainDateString,
  statementOpeningBalance: DecimalString,
  statementClosingBalance: DecimalString,
  status: z.enum(['in_progress', 'completed', 'flagged']),
  clearedBalance: DecimalString.nullable(),
  discrepancy: DecimalString.nullable(),
  completedAt: z.string().nullable(),
  completedBy: z.string().nullable(),
  flaggedReason: z.string().nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type ReconciliationDto = z.infer<typeof ReconciliationDto>;

export const ReconciliationLineDto = z.object({
  journalLineId: z.string(),
  entryId: z.string(),
  entryNumber: z.number().int().nullable(),
  date: PlainDateString,
  memo: z.string(),
  /** Signed effect on the bank account balance (positive increases the balance). */
  amount: DecimalString,
  cleared: z.boolean(),
  sourceType: z.string(),
});
export type ReconciliationLineDto = z.infer<typeof ReconciliationLineDto>;

export const ReconciliationDetailDto = ReconciliationDto.extend({
  lines: z.array(ReconciliationLineDto),
  /** Opening + cleared lines. */
  clearedBalance: DecimalString,
  discrepancy: DecimalString,
  ledgerBalanceAtEnd: DecimalString,
});
export type ReconciliationDetailDto = z.infer<typeof ReconciliationDetailDto>;

export const StartReconciliationInput = z
  .object({
    bankAccountId: Uuid,
    statementStartDate: PlainDateString,
    statementEndDate: PlainDateString,
    statementOpeningBalance: DecimalString,
    statementClosingBalance: DecimalString,
    notes: z.string().max(1000).nullable().optional(),
  })
  .refine((r) => r.statementStartDate <= r.statementEndDate, { message: 'Start must be on or before end' });
export type StartReconciliationInput = z.infer<typeof StartReconciliationInput>;

export const ToggleReconciliationItemsInput = z.object({
  version: z.number().int(),
  clear: z.array(Uuid).default([]),
  unclear: z.array(Uuid).default([]),
});

export const CompleteReconciliationInput = z.object({
  version: z.number().int(),
  idempotencyKey: IdempotencyKey.optional(),
});
