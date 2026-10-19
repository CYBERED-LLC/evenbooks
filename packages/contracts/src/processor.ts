import { z } from 'zod';
import { DecimalString, IdempotencyKey, NonNegativeDecimalString, PlainDateString, PositiveDecimalString, Uuid } from './common';

// ---------------------------------------------------------------------------
// Online payments through a payment processor (Stripe Connect). See docs/payments-plan.md.
// ---------------------------------------------------------------------------

export const ProcessorProvider = z.enum(['stripe']);
export type ProcessorProvider = z.infer<typeof ProcessorProvider>;

export const PaymentMethodKind = z.enum(['card', 'ach']);
export type PaymentMethodKind = z.infer<typeof PaymentMethodKind>;

export const ProcessorConnectionStatus = z.enum(['pending', 'active', 'restricted', 'disconnected']);

export const PlatformFeeDto = z.object({
  plan: z.enum(['free', 'paid']),
  /** All-in percent the business pays on card payments, Stripe's fee included ("0" on the paid plan, which pays only Stripe). */
  cardTotalPercent: z.string(),
  /** All-in percent on ACH bank debits, Stripe's fee included. */
  achTotalPercent: z.string(),
});
export type PlatformFeeDto = z.infer<typeof PlatformFeeDto>;

export const ProcessorConnectionDto = z.object({
  id: z.string(),
  provider: ProcessorProvider,
  providerAccountId: z.string(),
  status: ProcessorConnectionStatus,
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
  displayName: z.string().nullable(),
  /** created: Evenbooks created the account (hosted onboarding); linked: an existing account connected through OAuth. */
  origin: z.enum(['created', 'linked']),
  /** Stripe balance the account already held when it was linked; the books never recorded it. */
  linkedBalance: DecimalString.nullable(),
  linkedAt: z.string().nullable(),
  clearingAccountId: z.string(),
  clearingAccountName: z.string(),
  feeAccountId: z.string(),
  feeAccountName: z.string(),
  payoutBankAccountId: z.string().nullable(),
  payoutBankAccountName: z.string().nullable(),
  allowCard: z.boolean(),
  allowAch: z.boolean(),
  allowPartial: z.boolean(),
  minimumPayment: DecimalString,
  autoPostPayouts: z.boolean(),
  lastEventAt: z.string().nullable(),
  lastError: z.string().nullable(),
  dashboardUrl: z.string(),
  platformFee: PlatformFeeDto,
  /** Current Stripe balance as recorded in the books (clearing account balance). */
  clearingBalance: DecimalString,
  version: z.number().int(),
  createdAt: z.string(),
});
export type ProcessorConnectionDto = z.infer<typeof ProcessorConnectionDto>;

export const ConnectProcessorResultDto = z.object({
  connection: ProcessorConnectionDto,
  /** Hosted onboarding URL to redirect the administrator to. */
  onboardingUrl: z.string(),
});
export type ConnectProcessorResultDto = z.infer<typeof ConnectProcessorResultDto>;

export const LinkProcessorResultDto = z.object({
  /** Stripe sign-in and authorization page; Stripe returns to /api/processor/connection/link/callback. */
  url: z.string(),
});
export type LinkProcessorResultDto = z.infer<typeof LinkProcessorResultDto>;

export const UpdateProcessorConnectionInput = z.object({
  version: z.number().int(),
  payoutBankAccountId: Uuid.nullable().optional(),
  allowCard: z.boolean().optional(),
  allowAch: z.boolean().optional(),
  allowPartial: z.boolean().optional(),
  minimumPayment: NonNegativeDecimalString.optional(),
  autoPostPayouts: z.boolean().optional(),
});
export type UpdateProcessorConnectionInput = z.infer<typeof UpdateProcessorConnectionInput>;

export const ProcessorChargeStatus = z.enum(['pending', 'processing', 'succeeded', 'failed', 'canceled']);

export const ProcessorChargeDto = z.object({
  id: z.string(),
  provider: ProcessorProvider,
  providerPaymentIntentId: z.string().nullable(),
  providerChargeId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  contactId: z.string().nullable(),
  contactName: z.string().nullable(),
  origin: z.enum(['evenbooks', 'external']),
  method: z.enum(['card', 'ach', 'unknown']),
  status: ProcessorChargeStatus,
  currency: z.string(),
  amount: DecimalString,
  processorFee: DecimalString,
  platformFee: DecimalString,
  platformFeeRefunded: DecimalString,
  amountRefunded: DecimalString,
  amountDisputed: DecimalString,
  /** Still refundable through the processor. */
  refundableAmount: DecimalString,
  paymentId: z.string().nullable(),
  feeJournalEntryId: z.string().nullable(),
  payerEmail: z.string().nullable(),
  description: z.string().nullable(),
  failureMessage: z.string().nullable(),
  succeededAt: z.string().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type ProcessorChargeDto = z.infer<typeof ProcessorChargeDto>;

export const ListProcessorChargesQuery = z.object({
  invoiceId: Uuid.optional(),
  status: ProcessorChargeStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListProcessorChargesQuery = z.infer<typeof ListProcessorChargesQuery>;

export const ProcessorRefundDto = z.object({
  id: z.string(),
  chargeId: z.string(),
  providerRefundId: z.string().nullable(),
  providerDisputeId: z.string().nullable(),
  kind: z.enum(['refund', 'dispute', 'dispute_reversal']),
  origin: z.enum(['evenbooks', 'external']),
  status: z.enum(['pending', 'succeeded', 'failed', 'canceled']),
  amount: DecimalString,
  feeAmount: DecimalString,
  platformFeeRefunded: DecimalString,
  reason: z.string().nullable(),
  disputeStatus: z.string().nullable(),
  refundId: z.string().nullable(),
  paymentId: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string(),
});
export type ProcessorRefundDto = z.infer<typeof ProcessorRefundDto>;

export const RefundProcessorChargeInput = z.object({
  version: z.number().int(),
  amount: PositiveDecimalString,
  reason: z.string().min(1).max(500),
  idempotencyKey: IdempotencyKey.optional(),
});
export type RefundProcessorChargeInput = z.infer<typeof RefundProcessorChargeInput>;

export const ProcessorPayoutDto = z.object({
  id: z.string(),
  providerPayoutId: z.string(),
  status: z.enum(['pending', 'in_transit', 'paid', 'failed', 'canceled']),
  currency: z.string(),
  amount: DecimalString,
  arrivalDate: PlainDateString,
  description: z.string().nullable(),
  bankAccountId: z.string().nullable(),
  bankAccountName: z.string().nullable(),
  journalEntryId: z.string().nullable(),
  reversalEntryId: z.string().nullable(),
  failureMessage: z.string().nullable(),
  createdAt: z.string(),
});
export type ProcessorPayoutDto = z.infer<typeof ProcessorPayoutDto>;

export const ProcessorEventProblemDto = z.object({
  id: z.number(),
  eventType: z.string(),
  receivedAt: z.string(),
  attempts: z.number(),
  lastError: z.string().nullable(),
});
export type ProcessorEventProblemDto = z.infer<typeof ProcessorEventProblemDto>;

// Public (customer-facing) checkout ------------------------------------------

export const PublicOnlinePaymentDto = z.object({
  methods: z.array(PaymentMethodKind),
  allowPartial: z.boolean(),
  minimumPayment: DecimalString,
  /** Open balance minus payments still processing. */
  payableAmount: DecimalString,
  /** ACH debits accepted but not yet settled. */
  processingAmount: DecimalString,
});
export type PublicOnlinePaymentDto = z.infer<typeof PublicOnlinePaymentDto>;

export const PublicCheckoutInput = z.object({
  /** The customer picks how to pay before checkout; the fee depends on it. */
  method: PaymentMethodKind,
  /** Defaults to the payable amount. */
  amount: PositiveDecimalString.optional(),
});
export type PublicCheckoutInput = z.infer<typeof PublicCheckoutInput>;

export const PublicCheckoutDto = z.object({ url: z.string(), chargeId: z.string() });
export type PublicCheckoutDto = z.infer<typeof PublicCheckoutDto>;
