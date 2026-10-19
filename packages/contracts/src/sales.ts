import { InvoiceBrandingInput } from './invoice-presentation';
import { z } from 'zod';
import { PublicOnlinePaymentDto } from './processor';
import { Address, DecimalString, Discount, IdempotencyKey, NonNegativeDecimalString, Pagination, PlainDateString, PositiveDecimalString, Uuid, QueryBoolean, sortParams } from './common';

export const DocumentStatus = z.enum(['draft', 'issued', 'paid', 'void']);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

// ---------------------------------------------------------------------------
// Invoice / credit note lines
// ---------------------------------------------------------------------------
export const DocumentLineInput = z.object({
  itemId: Uuid.nullable().optional(),
  description: z.string().min(1).max(1000),
  quantity: NonNegativeDecimalString.default('1'),
  unitPrice: DecimalString,
  discount: Discount.nullable().optional(),
  incomeAccountId: Uuid,
  taxRateIds: z.array(Uuid).max(5).default([]),
});
export type DocumentLineInput = z.infer<typeof DocumentLineInput>;

export const LineTaxDto = z.object({ taxRateId: z.string(), name: z.string(), rate: z.string(), amount: DecimalString });

export const DocumentLineDto = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  itemId: z.string().nullable(),
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  discount: Discount.nullable(),
  incomeAccountId: z.string(),
  incomeAccountName: z.string().optional(),
  taxRateIds: z.array(z.string()),
  taxes: z.array(LineTaxDto),
  gross: DecimalString,
  lineDiscount: DecimalString,
  documentDiscountShare: DecimalString,
  net: DecimalString,
  taxTotal: DecimalString,
  total: DecimalString,
});
export type DocumentLineDto = z.infer<typeof DocumentLineDto>;

export const TaxSummaryDto = z.object({
  taxRateId: z.string(),
  name: z.string(),
  rate: z.string(),
  taxable: DecimalString,
  amount: DecimalString,
  liabilityAccountId: z.string(),
});

export const CustomerSnapshotDto = z.object({
  name: z.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: Address.optional(),
});

const documentTotals = {
  currency: z.string(),
  subtotal: DecimalString,
  discountTotal: DecimalString,
  netTotal: DecimalString,
  taxTotal: DecimalString,
  total: DecimalString,
  taxSummary: z.array(TaxSummaryDto),
};

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------
export const AllocationDto = z.object({
  id: z.string(),
  sourceType: z.enum(['payment', 'credit_note']),
  paymentId: z.string().nullable(),
  creditNoteId: z.string().nullable(),
  invoiceId: z.string(),
  invoiceNumber: z.string().nullable().optional(),
  amount: DecimalString,
  date: PlainDateString,
  status: z.enum(['active', 'reversed']),
  journalEntryId: z.string().nullable(),
  reversalJournalEntryId: z.string().nullable(),
  sourceLabel: z.string().optional(),
});
export type AllocationDto = z.infer<typeof AllocationDto>;

export const InvoiceDto = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: DocumentStatus,
  /** derived: issued, unpaid, past due */
  isOverdue: z.boolean(),
  contactId: z.string(),
  contactName: z.string().optional(),
  customerSnapshot: CustomerSnapshotDto,
  issueDate: PlainDateString,
  dueDate: PlainDateString,
  termsDays: z.number().int(),
  memo: z.string().nullable(),
  footer: z.string().nullable(),
  paymentUrl: z.string().nullable(),
  /** Hide the processor pay button on the public page for this invoice. */
  onlinePaymentsDisabled: z.boolean(),
  documentDiscount: Discount.nullable(),
  ...documentTotals,
  amountSettled: DecimalString,
  balanceDue: DecimalString,
  journalEntryId: z.string().nullable(),
  voidJournalEntryId: z.string().nullable(),
  voidReason: z.string().nullable(),
  recurringScheduleId: z.string().nullable(),
  recurringOccurrenceIndex: z.number().int().nullable(),
  hasPublicLink: z.boolean(),
  currentPdfAttachmentId: z.string().nullable(),
  issuedAt: z.string().nullable(),
  lastSentAt: z.string().nullable(),
  lines: z.array(DocumentLineDto),
  allocations: z.array(AllocationDto).optional(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type InvoiceDto = z.infer<typeof InvoiceDto>;

export const CreateInvoiceInput = z.object({
  contactId: Uuid,
  issueDate: PlainDateString,
  dueDate: PlainDateString.optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  lines: z.array(DocumentLineInput).min(1).max(200),
  documentDiscount: Discount.nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
  footer: z.string().max(2000).nullable().optional(),
  paymentUrl: z.url().startsWith('https://').nullable().optional(),
  onlinePaymentsDisabled: z.boolean().optional(),
});
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceInput>;

export const UpdateInvoiceInput = CreateInvoiceInput.partial().extend({ version: z.number().int() });
export type UpdateInvoiceInput = z.infer<typeof UpdateInvoiceInput>;

export const IssueInvoiceInput = z.object({
  version: z.number().int(),
  /** Override the accounting date at issue time (defaults to the draft issue date). */
  issueDate: PlainDateString.optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type IssueInvoiceInput = z.infer<typeof IssueInvoiceInput>;

export const VoidInvoiceInput = z.object({
  version: z.number().int(),
  reason: z.string().min(1).max(500),
  date: PlainDateString.optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type VoidInvoiceInput = z.infer<typeof VoidInvoiceInput>;

export const UpdateIssuedInvoiceInput = z.object({
  version: z.number().int(),
  paymentUrl: z.url().startsWith('https://').nullable().optional(),
  onlinePaymentsDisabled: z.boolean().optional(),
});

/** Invoice list sorts; the default is `issueDate` newest first. `customer` is the snapshot name, case-insensitive. */
export const INVOICE_SORTS = ['issueDate', 'dueDate', 'number', 'customer', 'total', 'balanceDue'] as const;
export type InvoiceSort = (typeof INVOICE_SORTS)[number];
export const ListInvoicesQuery = Pagination.extend({
  ...sortParams(INVOICE_SORTS).shape,
  status: DocumentStatus.optional(),
  contactId: Uuid.optional(),
  from: PlainDateString.optional(),
  to: PlainDateString.optional(),
  overdue: QueryBoolean.optional(),
  outstanding: QueryBoolean.optional(),
  q: z.string().max(200).optional(),
});
export type ListInvoicesQuery = z.infer<typeof ListInvoicesQuery>;

// ---------------------------------------------------------------------------
// Bulk actions on the invoice list
// ---------------------------------------------------------------------------
/** Each item carries its own idempotency key: a retry re-runs only the items that did not go through. */
const BulkInvoiceItems = z
  .array(z.object({ id: Uuid, version: z.number().int(), idempotencyKey: IdempotencyKey }))
  .min(1)
  .max(100);
export const BulkInvoiceInput = z.discriminatedUnion('action', [
  /** Issue drafts (posts each to the ledger). */
  z.object({ action: z.literal('issue'), items: BulkInvoiceItems }),
  /** Email issued invoices to the customer's address; ones without an email are skipped. */
  z.object({ action: z.literal('send'), items: BulkInvoiceItems, message: z.string().max(2000).nullable().optional() }),
]);
export type BulkInvoiceInput = z.infer<typeof BulkInvoiceInput>;

export const BulkInvoiceItemResult = z.object({
  id: z.string(),
  /** Invoice number (null for a draft that was not issued). */
  number: z.string().nullable(),
  ok: z.boolean(),
  /** Not attempted, e.g. no customer email on file. `error` says why. */
  skipped: z.boolean().optional(),
  invoice: InvoiceDto.optional(),
  email: z.lazy(() => EmailMessageDto).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type BulkInvoiceItemResult = z.infer<typeof BulkInvoiceItemResult>;

export const BulkInvoiceResultDto = z.object({
  action: z.enum(['issue', 'send']),
  results: z.array(BulkInvoiceItemResult),
  succeeded: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});
export type BulkInvoiceResultDto = z.infer<typeof BulkInvoiceResultDto>;

/** Customer-facing view served by the public invoice page. */
export const PublicInvoiceDto = z.object({
  number: z.string(),
  status: z.enum(['issued', 'paid', 'void']),
  isOverdue: z.boolean(),
  issueDate: PlainDateString,
  dueDate: PlainDateString,
  company: z.object({ name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), address: Address }),
  branding: InvoiceBrandingInput.optional(),
  customer: CustomerSnapshotDto,
  lines: z.array(z.object({ description: z.string(), quantity: z.string(), unitPrice: z.string(), lineDiscount: DecimalString, taxTotal: DecimalString, total: DecimalString, net: DecimalString })),
  currency: z.string(),
  subtotal: DecimalString,
  discountTotal: DecimalString,
  taxSummary: z.array(z.object({ name: z.string(), rate: z.string(), amount: DecimalString })),
  taxTotal: DecimalString,
  total: DecimalString,
  amountSettled: DecimalString,
  balanceDue: DecimalString,
  memo: z.string().nullable(),
  footer: z.string().nullable(),
  paymentUrl: z.string().nullable(),
  pdfAvailable: z.boolean(),
  /** Present when the company accepts online payments and this invoice can take one. */
  onlinePayment: PublicOnlinePaymentDto.nullable(),
});
export type PublicInvoiceDto = z.infer<typeof PublicInvoiceDto>;

export const PublicLinkDto = z.object({ url: z.string(), path: z.string() });

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
export const PaymentAllocationInput = z.object({ invoiceId: Uuid, amount: PositiveDecimalString });

export const CreatePaymentInput = z.object({
  contactId: Uuid.nullable().optional(),
  date: PlainDateString,
  amount: PositiveDecimalString,
  method: z.enum(['cash', 'check', 'card', 'ach', 'wire', 'other']).default('other'),
  reference: z.string().max(100).nullable().optional(),
  memo: z.string().max(1000).nullable().optional(),
  /** Bank account or Undeposited Funds. */
  depositAccountId: Uuid,
  /** Refundable security deposit: stays a liability on both bases until applied/forfeited. */
  isRefundableDeposit: z.boolean().default(false),
  allocations: z.array(PaymentAllocationInput).max(100).default([]),
  bankTransactionId: Uuid.nullable().optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type CreatePaymentInput = z.infer<typeof CreatePaymentInput>;

export const AllocatePaymentInput = z.object({
  version: z.number().int(),
  date: PlainDateString.optional(),
  allocations: z.array(PaymentAllocationInput).min(1).max(100),
  idempotencyKey: IdempotencyKey.optional(),
});
export type AllocatePaymentInput = z.infer<typeof AllocatePaymentInput>;

export const ReverseAllocationInput = z.object({
  reason: z.string().min(1).max(500),
  date: PlainDateString.optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type ReverseAllocationInput = z.infer<typeof ReverseAllocationInput>;

export const VoidPaymentInput = z.object({
  version: z.number().int(),
  reason: z.string().min(1).max(500),
  date: PlainDateString.optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type VoidPaymentInput = z.infer<typeof VoidPaymentInput>;

export const PaymentDto = z.object({
  id: z.string(),
  contactId: z.string().nullable(),
  contactName: z.string().nullable().optional(),
  date: PlainDateString,
  currency: z.string(),
  amount: DecimalString,
  method: z.string(),
  reference: z.string().nullable(),
  memo: z.string().nullable(),
  depositAccountId: z.string(),
  depositAccountName: z.string().optional(),
  isRefundableDeposit: z.boolean(),
  status: z.enum(['posted', 'void']),
  amountAllocated: DecimalString,
  amountRefunded: DecimalString,
  unappliedAmount: DecimalString,
  journalEntryId: z.string(),
  voidJournalEntryId: z.string().nullable(),
  voidReason: z.string().nullable(),
  bankTransactionId: z.string().nullable(),
  /** Set when the payment was collected online through the payment processor. */
  processorChargeId: z.string().nullable(),
  allocations: z.array(AllocationDto),
  version: z.number().int(),
  createdAt: z.string(),
});
export type PaymentDto = z.infer<typeof PaymentDto>;

export const PAYMENT_SORTS = ['date', 'amount', 'customer', 'unapplied'] as const;
export const ListPaymentsQuery = Pagination.extend({
  ...sortParams(PAYMENT_SORTS).shape,
  contactId: Uuid.optional(),
  from: PlainDateString.optional(),
  to: PlainDateString.optional(),
  status: z.enum(['posted', 'void']).optional(),
  unappliedOnly: QueryBoolean.optional(),
  q: z.string().max(200).optional(),
});
export type ListPaymentsQuery = z.infer<typeof ListPaymentsQuery>;

// ---------------------------------------------------------------------------
// Credit notes
// ---------------------------------------------------------------------------
export const CreditNoteDto = z.object({
  id: z.string(),
  number: z.string().nullable(),
  status: DocumentStatus,
  contactId: z.string(),
  contactName: z.string().optional(),
  invoiceId: z.string().nullable(),
  invoiceNumber: z.string().nullable().optional(),
  customerSnapshot: CustomerSnapshotDto,
  issueDate: PlainDateString,
  reason: z.string().nullable(),
  documentDiscount: Discount.nullable(),
  ...documentTotals,
  amountUsed: DecimalString,
  balance: DecimalString,
  journalEntryId: z.string().nullable(),
  voidJournalEntryId: z.string().nullable(),
  voidReason: z.string().nullable(),
  lines: z.array(DocumentLineDto),
  allocations: z.array(AllocationDto).optional(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type CreditNoteDto = z.infer<typeof CreditNoteDto>;

export const CreateCreditNoteInput = z.object({
  contactId: Uuid,
  invoiceId: Uuid.nullable().optional(),
  issueDate: PlainDateString,
  reason: z.string().max(1000).nullable().optional(),
  lines: z.array(DocumentLineInput).min(1).max(200),
  documentDiscount: Discount.nullable().optional(),
});
export type CreateCreditNoteInput = z.infer<typeof CreateCreditNoteInput>;

export const UpdateCreditNoteInput = CreateCreditNoteInput.partial().extend({ version: z.number().int() });

export const IssueCreditNoteInput = z.object({
  version: z.number().int(),
  /** Apply immediately to this invoice (up to its open balance). */
  applyToInvoiceId: Uuid.nullable().optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type IssueCreditNoteInput = z.infer<typeof IssueCreditNoteInput>;

export const ApplyCreditNoteInput = z.object({
  version: z.number().int(),
  date: PlainDateString.optional(),
  allocations: z.array(PaymentAllocationInput).min(1).max(100),
  idempotencyKey: IdempotencyKey.optional(),
});
export type ApplyCreditNoteInput = z.infer<typeof ApplyCreditNoteInput>;

export const VoidCreditNoteInput = VoidInvoiceInput;

/** Credit note list sorts (keys match the invoice list); the default is `issueDate` newest first. */
export const CREDIT_NOTE_SORTS = ['issueDate', 'number', 'total', 'customer'] as const;
export const ListCreditNotesQuery = Pagination.extend({
  ...sortParams(CREDIT_NOTE_SORTS).shape,
  status: DocumentStatus.optional(),
  contactId: Uuid.optional(),
  from: PlainDateString.optional(),
  to: PlainDateString.optional(),
  q: z.string().max(200).optional(),
});
export type ListCreditNotesQuery = z.infer<typeof ListCreditNotesQuery>;

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------
export const CreateRefundInput = z.object({
  sourceType: z.enum(['payment', 'credit_note']),
  sourceId: Uuid,
  date: PlainDateString,
  amount: PositiveDecimalString,
  fromAccountId: Uuid,
  method: z.enum(['cash', 'check', 'card', 'ach', 'wire', 'other']).default('other'),
  reference: z.string().max(100).nullable().optional(),
  memo: z.string().max(1000).nullable().optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type CreateRefundInput = z.infer<typeof CreateRefundInput>;

export const RefundDto = z.object({
  id: z.string(),
  contactId: z.string().nullable(),
  sourceType: z.enum(['payment', 'credit_note']),
  paymentId: z.string().nullable(),
  creditNoteId: z.string().nullable(),
  date: PlainDateString,
  amount: DecimalString,
  fromAccountId: z.string(),
  fromAccountName: z.string().optional(),
  method: z.string(),
  reference: z.string().nullable(),
  memo: z.string().nullable(),
  status: z.enum(['posted', 'void']),
  journalEntryId: z.string(),
  voidJournalEntryId: z.string().nullable(),
  createdAt: z.string(),
});
export type RefundDto = z.infer<typeof RefundDto>;

export const VoidRefundInput = z.object({ reason: z.string().min(1).max(500), idempotencyKey: IdempotencyKey.optional() });

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------
export const EmailStatus = z.enum(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'uncertain', 'suppressed']);

export const EmailMessageDto = z.object({
  id: z.string(),
  kind: z.string(),
  invoiceId: z.string().nullable(),
  toEmail: z.string(),
  fromEmail: z.string().nullable().optional(),
  replyTo: z.string().nullable().optional(),
  templateVersion: z.number().nullable().optional(),
  subject: z.string(),
  status: EmailStatus,
  providerMessageId: z.string().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  isResend: z.boolean(),
  requestedBy: z.string(),
  queuedAt: z.string(),
  sentAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
});
export type EmailMessageDto = z.infer<typeof EmailMessageDto>;

export const SendInvoiceEmailInput = z.object({
  to: z.email(),
  message: z.string().max(5000).nullable().optional(),
  subject: z.string().trim().min(1).max(250).refine((s) => !/[\r\n]/.test(s)).optional(),
  usePlatformSender: z.boolean().optional(),
  idempotencyKey: IdempotencyKey.optional(),
});
export type SendInvoiceEmailInput = z.infer<typeof SendInvoiceEmailInput>;

// ---------------------------------------------------------------------------
// Customer statement / open items
// ---------------------------------------------------------------------------
export const OpenInvoiceDto = z.object({
  id: z.string(),
  number: z.string(),
  issueDate: PlainDateString,
  dueDate: PlainDateString,
  total: DecimalString,
  balanceDue: DecimalString,
  isOverdue: z.boolean(),
});
export type OpenInvoiceDto = z.infer<typeof OpenInvoiceDto>;

export const CustomerBalanceDto = z.object({
  contactId: z.string(),
  openInvoices: z.array(OpenInvoiceDto),
  unappliedPayments: z.array(z.object({ id: z.string(), date: PlainDateString, unappliedAmount: DecimalString, reference: z.string().nullable(), isRefundableDeposit: z.boolean() })),
  openCreditNotes: z.array(z.object({ id: z.string(), number: z.string(), issueDate: PlainDateString, balance: DecimalString })),
  totalReceivable: DecimalString,
  totalCredits: DecimalString,
});
export type CustomerBalanceDto = z.infer<typeof CustomerBalanceDto>;
