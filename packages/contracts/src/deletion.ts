import { z } from 'zod';
import { IdempotencyKey, Uuid } from './common';

/** Records that can be deleted permanently (with their journal entries). */
export const DeletableType = z.enum(['invoice', 'credit_note', 'payment', 'refund', 'purchase', 'journal_entry', 'bank_transaction']);
export type DeletableType = z.infer<typeof DeletableType>;

export const DeletionTarget = z.object({ type: DeletableType, id: Uuid });
export type DeletionTarget = z.infer<typeof DeletionTarget>;

export const DeletionBlocker = z.object({
  code: z.string(),
  message: z.string(),
  /** The dependent record to delete or change first. */
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }).nullable(),
});
export type DeletionBlocker = z.infer<typeof DeletionBlocker>;

export const DeletionPreviewDto = z.object({
  type: DeletableType,
  id: z.string(),
  label: z.string(),
  version: z.number().int(),
  /** Journal entries removed with the record. */
  entries: z.array(z.object({ id: z.string(), entryNumber: z.number().int().nullable(), date: z.string(), memo: z.string(), amount: z.string(), sourceType: z.string() })),
  blockers: z.array(DeletionBlocker),
  /** Closed periods covering any of the entry dates (blocks the delete). */
  lockedDates: z.array(z.string()),
  /** Completed reconciliations that will be reopened. */
  reconciliations: z.array(z.object({ id: z.string(), bankAccountName: z.string(), statementEndDate: z.string(), status: z.string() })),
  /** Bank lines that go back to the inbox. */
  bankTransactions: z.array(z.object({ id: z.string(), date: z.string(), description: z.string(), amount: z.string() })),
  /** Invoices or credit notes whose balances are recalculated. */
  affectedDocuments: z.array(z.object({ type: z.string(), id: z.string(), label: z.string() })),
  /** Invoice has a customer link or emails that will stop working. */
  customerFacing: z.boolean(),
  canDelete: z.boolean(),
});
export type DeletionPreviewDto = z.infer<typeof DeletionPreviewDto>;

export const DeleteRecordInput = DeletionTarget.extend({
  version: z.number().int(),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: IdempotencyKey.optional(),
});
export type DeleteRecordInput = z.infer<typeof DeleteRecordInput>;

export const DeleteRecordResultDto = z.object({ type: DeletableType, id: z.string(), entriesDeleted: z.number().int(), reconciliationsReopened: z.number().int() });
export type DeleteRecordResultDto = z.infer<typeof DeleteRecordResultDto>;
