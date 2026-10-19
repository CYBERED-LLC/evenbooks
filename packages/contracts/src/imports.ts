import { z } from 'zod';
import { DecimalString, IdempotencyKey, PlainDateString, Uuid } from './common';

// ---------------------------------------------------------------------------
// Ledger history import (general-ledger CSV from another accounting system)
// ---------------------------------------------------------------------------
export const LedgerCsvMapping = z.object({
  date: z.string().min(1),
  account: z.string().min(1),
  description: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  /** Transaction id column; when null, rows are grouped per `grouping`. */
  group: z.string().nullable().optional(),
  /** Without an id column: `sequence` (file order until lines balance) or `date-description` (same date and description). */
  grouping: z.enum(['sequence', 'date-description']).nullable().optional(),
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
export type LedgerCsvMapping = z.infer<typeof LedgerCsvMapping>;

export const CreateLedgerImportInput = z.object({
  fileName: z.string().min(1).max(255),
  /** Raw CSV text (UTF-8). */
  content: z.string().min(1).max(10 * 1024 * 1024),
});
export type CreateLedgerImportInput = z.infer<typeof CreateLedgerImportInput>;

export const ImportCashComponentInput = z.object({ accountId: Uuid, amount: DecimalString });
export type ImportCashComponentInput = z.infer<typeof ImportCashComponentInput>;

export const UpdateLedgerImportInput = z.object({
  mapping: LedgerCsvMapping.optional(),
  cashOverrides: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.array(ImportCashComponentInput).max(200)).optional(),
  /** Source account name -> Evenbooks account id (null clears). Merged into the saved map. */
  accountMap: z.record(z.string(), Uuid.nullable()).optional(),
});
export type UpdateLedgerImportInput = z.infer<typeof UpdateLedgerImportInput>;

export const CommitLedgerImportInput = z.object({ idempotencyKey: IdempotencyKey.optional() });
export type CommitLedgerImportInput = z.infer<typeof CommitLedgerImportInput>;

export const LedgerImportAccountDto = z.object({
  /** Account name as it appears in the file. */
  source: z.string(),
  lineCount: z.number().int(),
  debitTotal: DecimalString,
  creditTotal: DecimalString,
  accountId: z.string().nullable(),
  /** Why the mapped account cannot receive imported lines (archived, control account…). */
  problem: z.string().nullable(),
});
export type LedgerImportAccountDto = z.infer<typeof LedgerImportAccountDto>;

export const LedgerImportEntryDto = z.object({
  key: z.string(),
  cashKey: z.string().nullable(),
  cashReviewRequired: z.boolean(),
  cashComponents: z.array(ImportCashComponentInput).nullable(),
  rowNos: z.array(z.number().int()),
  date: PlainDateString.nullable(),
  description: z.string(),
  reference: z.string().nullable(),
  status: z.enum(['ok', 'duplicate', 'error']),
  error: z.string().nullable(),
  lines: z.array(z.object({ rowNo: z.number().int(), account: z.string(), debit: DecimalString, credit: DecimalString, memo: z.string().nullable() })),
});
export type LedgerImportEntryDto = z.infer<typeof LedgerImportEntryDto>;

export const LedgerImportDto = z.object({
  id: z.string(),
  fileName: z.string(),
  status: z.enum(['previewed', 'committed', 'discarded']),
  mapping: LedgerCsvMapping.nullable(),
  rowCount: z.number().int(),
  entryCount: z.number().int(),
  /** Entries that will post on commit (balanced, not duplicate, not in a closed period). */
  readyCount: z.number().int(),
  importedCount: z.number().int(),
  duplicateCount: z.number().int(),
  errorCount: z.number().int(),
  windowStart: PlainDateString.nullable(),
  windowEnd: PlainDateString.nullable(),
  createdAt: z.string(),
  committedAt: z.string().nullable(),
  /** Detail, present on the single-import endpoints only. */
  headers: z.array(z.string()).optional(),
  /** A known export layout whose columns were set automatically (detail only). */
  recognizedFormat: z.enum(['wave_transactions', 'wave_ledger']).nullable().optional(),
  alreadyCommitted: z.boolean().optional(),
  accounts: z.array(LedgerImportAccountDto).optional(),
  /** Problem entries first, then the first ready ones; capped (see `entriesTruncated`). */
  entries: z.array(LedgerImportEntryDto).optional(),
  entriesTruncated: z.boolean().optional(),
});
export type LedgerImportDto = z.infer<typeof LedgerImportDto>;
