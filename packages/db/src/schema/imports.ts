import { pgTable, text, uuid, integer, date, jsonb } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamptz } from './columns';

/** Column mapping for a general-ledger CSV (mirrors `LedgerCsvMapping` in @evenbooks/domain). */
export interface LedgerCsvMappingJson {
  date: string;
  account: string;
  description?: string | null;
  memo?: string | null;
  reference?: string | null;
  group?: string | null;
  grouping?: 'sequence' | 'date-description' | null;
  amounts: { amount?: string | null; debit?: string | null; credit?: string | null; invert?: boolean };
  dateOrder: 'YMD' | 'MDY' | 'DMY';
}

export const ledgerImports = pgTable('ledger_imports', {
  id: uuid().primaryKey().defaultRandom(),
  companyId: uuid().notNull(),
  fileAttachmentId: uuid(),
  fileName: text().notNull(),
  fileSha256: text().notNull(),
  mapping: jsonb().$type<LedgerCsvMappingJson | null>(),
  /** Source account name -> Evenbooks account id; null marks an account the user cleared. */
  accountMap: jsonb().$type<Record<string, string | null>>().notNull().default({}),
  cashOverrides: jsonb().$type<Record<string, { accountId: string; amount: string }[]>>().notNull().default({}),
  status: text({ enum: ['previewed', 'committed', 'discarded'] }).notNull().default('previewed'),
  rowCount: integer().notNull().default(0),
  entryCount: integer().notNull().default(0),
  readyCount: integer().notNull().default(0),
  importedCount: integer().notNull().default(0),
  duplicateCount: integer().notNull().default(0),
  errorCount: integer().notNull().default(0),
  windowStart: date({ mode: 'string' }),
  windowEnd: date({ mode: 'string' }),
  createdBy: text().notNull(),
  createdAt: timestamptz().notNull().default(sql`now()`),
  committedAt: timestamptz(),
});
