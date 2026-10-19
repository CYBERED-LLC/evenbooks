import { z } from 'zod';
import { ProcessorEventProblemDto } from './processor';
import { DecimalString, Discount, IdempotencyKey, PlainDateString, Uuid } from './common';
import { DocumentLineInput } from './sales';

// ---------------------------------------------------------------------------
// Recurring invoices
// ---------------------------------------------------------------------------
export const Frequency = z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannually', 'yearly']);
export type Frequency = z.infer<typeof Frequency>;

export const ScheduleStatus = z.enum(['active', 'paused', 'cancelled', 'completed']);

export const RecurringTemplateInput = z.object({
  lines: z.array(DocumentLineInput).min(1).max(200),
  documentDiscount: Discount.nullable().optional(),
  memo: z.string().max(2000).nullable().optional(),
  footer: z.string().max(2000).nullable().optional(),
  /** Reusable payment URL. Single-use links from the source invoice are never copied automatically. */
  paymentUrl: z.url().startsWith('https://').nullable().optional(),
});
export type RecurringTemplateInput = z.infer<typeof RecurringTemplateInput>;

export const CreateScheduleInput = z.object({
  /** "Repeat this invoice": copy an issued invoice's contents. */
  fromInvoiceId: Uuid.optional(),
  contactId: Uuid.optional(),
  name: z.string().min(1).max(120),
  frequency: Frequency,
  anchorDate: PlainDateString,
  endDate: PlainDateString.nullable().optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  sendEmail: z.boolean().default(false),
  emailTo: z.email().nullable().optional(),
  template: RecurringTemplateInput.optional(),
  /** Copy the source invoice's payment URL into the template (only if the user confirms it is reusable). */
  copyPaymentUrl: z.boolean().default(false),
});
export type CreateScheduleInput = z.infer<typeof CreateScheduleInput>;

export const UpdateScheduleInput = z.object({
  version: z.number().int(),
  name: z.string().min(1).max(120).optional(),
  endDate: PlainDateString.nullable().optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  sendEmail: z.boolean().optional(),
  emailTo: z.email().nullable().optional(),
  /** Replacing the template creates a new template version for future occurrences only. */
  template: RecurringTemplateInput.optional(),
});
export type UpdateScheduleInput = z.infer<typeof UpdateScheduleInput>;

export const ResumeScheduleInput = z.object({
  version: z.number().int(),
  /** 'catch_up' issues every missed occurrence; 'skip' resumes from the next future occurrence. */
  mode: z.enum(['catch_up', 'skip']),
  idempotencyKey: IdempotencyKey.optional(),
});
export type ResumeScheduleInput = z.infer<typeof ResumeScheduleInput>;

export const ScheduleOccurrenceDto = z.object({
  index: z.number().int(),
  date: PlainDateString,
  invoiceId: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceStatus: z.string().nullable(),
});

export const ScheduleDto = z.object({
  id: z.string(),
  name: z.string(),
  status: ScheduleStatus,
  contactId: z.string(),
  contactName: z.string().optional(),
  frequency: Frequency,
  anchorDate: PlainDateString,
  endDate: PlainDateString.nullable(),
  termsDays: z.number().int(),
  sendEmail: z.boolean(),
  emailTo: z.string().nullable(),
  templateVersion: z.number().int(),
  template: RecurringTemplateInput,
  templateTotal: DecimalString.optional(),
  lastIssuedIndex: z.number().int().nullable(),
  lastIssuedAt: z.string().nullable(),
  nextOccurrenceDate: PlainDateString.nullable(),
  nextRunAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  createdFromInvoiceId: z.string().nullable(),
  occurrences: z.array(ScheduleOccurrenceDto).optional(),
  /** Missed occurrences that would be issued on catch-up resume. */
  catchUp: z.array(ScheduleOccurrenceDto).optional(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type ScheduleDto = z.infer<typeof ScheduleDto>;

// ---------------------------------------------------------------------------
// Bank connections (SimpleFIN)
// ---------------------------------------------------------------------------
export const ConnectionStatus = z.enum(['active', 'error', 'revoked', 'disabled']);

export const BankConnectionDto = z.object({
  id: z.string(),
  provider: z.literal('simplefin'),
  name: z.string(),
  status: ConnectionStatus,
  syncIntervalMinutes: z.number().int(),
  nextSyncAt: z.string().nullable(),
  lastSyncStartedAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  /** Derived: no success in > 2 intervals. */
  isStale: z.boolean(),
  accounts: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(['bank', 'credit_card']),
        providerAccountId: z.string().nullable(),
        providerOrgName: z.string().nullable(),
        lastBalance: DecimalString.nullable(),
        lastBalanceAt: z.string().nullable(),
        lastSyncedAt: z.string().nullable(),
      }),
    )
    .optional(),
  version: z.number().int(),
  createdAt: z.string(),
});
export type BankConnectionDto = z.infer<typeof BankConnectionDto>;

export const ConnectSimpleFinInput = z.object({
  name: z.string().min(1).max(120),
  /** SimpleFIN setup token (base64 claim URL) — used once, never stored. */
  setupToken: z.string().min(16).max(4000),
  syncIntervalMinutes: z.number().int().min(60).max(1440).default(360),
});
export type ConnectSimpleFinInput = z.infer<typeof ConnectSimpleFinInput>;

export const DiscoveredAccountDto = z.object({
  providerAccountId: z.string(),
  name: z.string(),
  orgName: z.string().nullable(),
  currency: z.string(),
  balance: DecimalString.nullable(),
  balanceDate: z.string().nullable(),
  /** Already linked bank account id, if any. */
  bankAccountId: z.string().nullable(),
});
export type DiscoveredAccountDto = z.infer<typeof DiscoveredAccountDto>;

export const LinkProviderAccountsInput = z.object({
  version: z.number().int(),
  links: z
    .array(
      z.object({
        providerAccountId: z.string(),
        /** Link to an existing bank account, or create a new one. */
        bankAccountId: Uuid.optional(),
        create: z
          .object({
            name: z.string().min(1).max(120),
            kind: z.enum(['bank', 'credit_card']),
            ledgerAccountId: Uuid.optional(),
            newLedgerAccount: z.object({ code: z.string().min(1).max(20), name: z.string().min(1).max(120) }).optional(),
          })
          .optional(),
      }),
    )
    .min(1),
});
export type LinkProviderAccountsInput = z.infer<typeof LinkProviderAccountsInput>;

export const SyncResultDto = z.object({
  connectionId: z.string(),
  ok: z.boolean(),
  inserted: z.number().int(),
  updated: z.number().int(),
  changed: z.number().int(),
  windowStart: PlainDateString.nullable(),
  windowEnd: PlainDateString.nullable(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
});
export type SyncResultDto = z.infer<typeof SyncResultDto>;

// ---------------------------------------------------------------------------
// Job / system status
// ---------------------------------------------------------------------------
/** A retry requested from the jobs page for one failed job. */
export const FailedJobRetryDto = z.object({
  requestedAt: z.string(),
  /** When the worker turned the request into a new job; null until its next run. */
  dispatchedAt: z.string().nullable(),
});
export type FailedJobRetryDto = z.infer<typeof FailedJobRetryDto>;

export const JobStatusDto = z.object({
  queues: z.array(z.object({ name: z.string(), created: z.number(), active: z.number(), retry: z.number(), failed: z.number(), completed: z.number() })),
  failedJobs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      createdOn: z.string(),
      completedOn: z.string().nullable(),
      retryCount: z.number(),
      output: z.unknown(),
      data: z.unknown(),
      /** An admin may re-run it from the jobs page. */
      retryable: z.boolean(),
      retry: FailedJobRetryDto.nullable(),
    }),
  ),
  outboxPending: z.number(),
  outboxOldestAgeSeconds: z.number().nullable(),
  staleConnections: z.array(z.object({ id: z.string(), name: z.string(), lastSuccessAt: z.string().nullable(), lastError: z.string().nullable() })),
  emailProblems: z.array(z.object({ id: z.string(), invoiceId: z.string().nullable(), toEmail: z.string(), status: z.string(), lastError: z.string().nullable(), queuedAt: z.string() })),
  workerHeartbeatAt: z.string().nullable(),
  processorEventProblems: z.array(ProcessorEventProblemDto),
});
export type JobStatusDto = z.infer<typeof JobStatusDto>;

export const RetryJobResultDto = z.object({
  jobId: z.string(),
  queue: z.string(),
  /** `already_requested`: a retry for this failed job exists; nothing new was queued. */
  status: z.enum(['queued', 'already_requested']),
  retry: FailedJobRetryDto,
});
export type RetryJobResultDto = z.infer<typeof RetryJobResultDto>;
