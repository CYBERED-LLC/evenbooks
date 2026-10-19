import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { schema } from '@evenbooks/db';
import type { ObjectStorage } from '@evenbooks/integrations';
import { CsvRowError, normalizeCsvRow, rowFingerprint, type CsvMapping as DomainMapping } from '@evenbooks/domain';
import type { CsvMapping, ImportBatchDto, ImportRowDto, PreviewCsvInput } from '@evenbooks/contracts';
import { ServiceError, notFound, plainDate } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';
import { idempotent } from './idempotency';
import { getBankAccount } from './bank-accounts';
import { uploadAttachment } from './attachments';

type BatchRow = typeof schema.importBatches.$inferSelect;

const DELETED_ROW_NOTE = 'Deleted earlier from Evenbooks; skipped';

/** Fingerprints of bank lines that were deleted permanently; imports skip them so they stay gone. */
async function deletedFingerprints(s: ServiceContext, bankAccountId: string, fps: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < fps.length; i += 5000) {
    const rows = await s.tx
      .select({ fingerprint: schema.deletedBankTransactions.fingerprint })
      .from(schema.deletedBankTransactions)
      .where(and(eq(schema.deletedBankTransactions.companyId, s.ctx.companyId), eq(schema.deletedBankTransactions.bankAccountId, bankAccountId), inArray(schema.deletedBankTransactions.fingerprint, fps.slice(i, i + 5000))));
    for (const r of rows) found.add(r.fingerprint!);
  }
  return found;
}

interface PreviewRow {
  rowNo: number;
  raw: Record<string, string>;
  normalized: { date: string; amount: string; description: string; memo: string | null; reference: string | null } | null;
  fingerprint: string | null;
  status: 'ok' | 'duplicate' | 'error';
  error: string | null;
  duplicateOf: string | null;
}

const HEADER_HINTS: Record<keyof Omit<CsvMapping, 'amounts' | 'dateOrder'> | 'amount' | 'debit' | 'credit', RegExp> = {
  date: /^(posted\s*)?(transaction\s*)?date$|^posted$|^date posted$/i,
  description: /^(description|payee|name|merchant|details|memo\/description|transaction)$/i,
  memo: /^(memo|notes?|extended description|original description)$/i,
  reference: /^(reference|ref(erence)? ?(no|number|#)?|check ?(no|number|#)|transaction id|id)$/i,
  amount: /^(amount|transaction amount|amt)$/i,
  debit: /^(debit|withdrawals?|money out|outflow|charges?)$/i,
  credit: /^(credit|deposits?|money in|inflow|payments?)$/i,
};

/** Best-effort column mapping from headers; the user confirms/adjusts in the preview. */
export function detectMapping(headers: string[]): CsvMapping | null {
  const find = (re: RegExp) => headers.find((h) => re.test(h.trim()));
  const date = find(HEADER_HINTS.date) ?? headers.find((h) => /date/i.test(h));
  const description = find(HEADER_HINTS.description) ?? headers.find((h) => /desc|payee|name|merchant/i.test(h));
  const amount = find(HEADER_HINTS.amount);
  const debit = find(HEADER_HINTS.debit);
  const credit = find(HEADER_HINTS.credit);
  if (!date || !description || (!amount && !debit && !credit)) return null;
  return {
    date,
    description,
    memo: find(HEADER_HINTS.memo) ?? null,
    reference: find(HEADER_HINTS.reference) ?? null,
    amounts: amount ? { amount } : { debit: debit ?? null, credit: credit ?? null },
    dateOrder: 'MDY',
  };
}

export function parseCsv(content: string): { headers: string[]; records: Record<string, string>[] } {
  let records: Record<string, string>[];
  try {
    records = parse(content.replace(/^﻿/, ''), {
      columns: (header: string[]) => header.map((h) => h.trim()),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
      bom: true,
    }) as Record<string, string>[];
  } catch (err) {
    throw new ServiceError('validation', `This file couldn’t be read as a CSV (${(err as Error).message}). Download it from your bank again as CSV and retry.`);
  }
  if (records.length === 0) throw new ServiceError('validation', 'The file has no transactions under its header row. Check that you downloaded the right file.');
  const headers = Object.keys(records[0]!);
  return { headers, records };
}

/** Every column a mapping reads from. */
export function mappingColumns(m: CsvMapping): string[] {
  return [m.date, m.description, m.memo, m.reference, m.amounts.amount, m.amounts.debit, m.amounts.credit].filter((c): c is string => Boolean(c));
}

/**
 * The mapping of this account's most recent committed CSV import, if every
 * column it reads is present in `headers`. Banks rarely change their export
 * format, so this beats header guessing (and keeps choices such as date order
 * and "invert amounts" that guessing can't know).
 */
export async function lastUsedMapping(s: ServiceContext, bankAccountId: string, headers: string[]): Promise<CsvMapping | null> {
  const [last] = await s.tx
    .select({ mapping: schema.importBatches.mapping })
    .from(schema.importBatches)
    .where(
      and(
        eq(schema.importBatches.companyId, s.ctx.companyId),
        eq(schema.importBatches.bankAccountId, bankAccountId),
        eq(schema.importBatches.source, 'csv'),
        eq(schema.importBatches.status, 'committed'),
      ),
    )
    .orderBy(desc(schema.importBatches.committedAt), desc(schema.importBatches.createdAt))
    .limit(1);
  const m = (last?.mapping as CsvMapping | null | undefined) ?? null;
  if (!m) return null;
  const have = new Set(headers);
  return mappingColumns(m).every((c) => have.has(c)) ? m : null;
}

/**
 * Parse, normalize and fingerprint a CSV against a bank account. Persists the
 * batch and rows as `previewed` so commit is a second, explicit step. The file
 * itself is kept as an attachment (kind csv_import) for provenance.
 */
export async function previewCsv(s: ServiceContext, storage: ObjectStorage, input: PreviewCsvInput): Promise<ImportBatchDto> {
  const bankAccount = await getBankAccount(s, input.bankAccountId);
  const { headers, records } = parseCsv(input.content);
  const mapping = input.mapping ?? (await lastUsedMapping(s, bankAccount.id, headers)) ?? detectMapping(headers);
  const fileSha = createHash('sha256').update(input.content).digest('hex');

  const [already] = await s.tx
    .select({ id: schema.importBatches.id })
    .from(schema.importBatches)
    .where(
      and(
        eq(schema.importBatches.companyId, s.ctx.companyId),
        eq(schema.importBatches.bankAccountId, bankAccount.id),
        eq(schema.importBatches.fileSha256, fileSha),
        eq(schema.importBatches.status, 'committed'),
      ),
    );

  const rows: PreviewRow[] = [];
  if (mapping) {
    const domainMapping: DomainMapping = { ...mapping, dateOrder: mapping.dateOrder };
    const seq = new Map<string, number>();
    const fps: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const raw = records[i]!;
      try {
        const n = normalizeCsvRow(raw, domainMapping);
        const base = `${n.date}|${n.amount}|${n.description.toLowerCase()}`;
        const k = seq.get(base) ?? 0;
        seq.set(base, k + 1);
        const fp = rowFingerprint(bankAccount.id, n, k);
        fps.push(fp);
        rows.push({ rowNo: i + 1, raw, normalized: n, fingerprint: fp, status: 'ok', error: null, duplicateOf: null });
      } catch (err) {
        const msg = err instanceof CsvRowError ? `${err.field}: ${err.message}` : (err as Error).message;
        rows.push({ rowNo: i + 1, raw, normalized: null, fingerprint: null, status: 'error', error: msg, duplicateOf: null });
      }
    }
    if (fps.length) {
      const existing: { id: string; fingerprint: string | null }[] = [];
      for (let i = 0; i < fps.length; i += 5000) {
        existing.push(
          ...(await s.tx
            .select({ id: schema.bankTransactions.id, fingerprint: schema.bankTransactions.fingerprint })
            .from(schema.bankTransactions)
            .where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), eq(schema.bankTransactions.bankAccountId, bankAccount.id), inArray(schema.bankTransactions.fingerprint, fps.slice(i, i + 5000))))),
        );
      }
      const byFp = new Map(existing.map((e) => [e.fingerprint!, e.id]));
      const deleted = await deletedFingerprints(s, bankAccount.id, fps);
      for (const r of rows) {
        if (r.fingerprint && byFp.has(r.fingerprint)) {
          r.status = 'duplicate';
          r.duplicateOf = byFp.get(r.fingerprint)!;
        } else if (r.fingerprint && deleted.has(r.fingerprint)) {
          r.status = 'duplicate';
          r.error = DELETED_ROW_NOTE;
        }
      }
    }
  }

  const dates = rows.filter((r) => r.normalized).map((r) => r.normalized!.date).sort();
  const attachment = await uploadAttachment(s, storage, {
    kind: 'csv_import',
    fileName: input.fileName,
    contentType: 'text/csv',
    body: new TextEncoder().encode(input.content),
  });
  const [batch] = await s.tx
    .insert(schema.importBatches)
    .values({
      companyId: s.ctx.companyId,
      bankAccountId: bankAccount.id,
      source: 'csv',
      fileAttachmentId: attachment.id,
      fileName: input.fileName,
      fileSha256: fileSha,
      mapping: mapping ?? null,
      status: 'previewed',
      rowCount: rows.length,
      importedCount: 0,
      duplicateCount: rows.filter((r) => r.status === 'duplicate').length,
      errorCount: rows.filter((r) => r.status === 'error').length,
      windowStart: dates[0] ?? null,
      windowEnd: dates[dates.length - 1] ?? null,
      createdBy: s.ctx.actorId,
    })
    .returning();
  // Chunked insert: PostgreSQL allows at most 65,535 bind parameters per statement.
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await s.tx.insert(schema.importRows).values(
      rows.slice(i, i + CHUNK).map((r) => ({
        companyId: s.ctx.companyId,
        batchId: batch!.id,
        rowNo: r.rowNo,
        raw: r.raw,
        normalized: r.normalized,
        fingerprint: r.fingerprint,
        status: r.status,
        error: r.error,
        duplicateOf: r.duplicateOf,
      })),
    );
  }
  await s.tx.update(schema.attachments).set({ entityType: 'import_batch', entityId: batch!.id }).where(eq(schema.attachments.id, attachment.id));
  return { ...toBatchDto(batch!, headers), alreadyCommitted: Boolean(already), rows: rows.map(toRowDto) };
}

/** Re-run normalization for a previewed batch with a corrected mapping. */
export async function remapBatch(s: ServiceContext, storage: ObjectStorage, batchId: string, mapping: CsvMapping): Promise<ImportBatchDto> {
  const batch = await loadBatch(s, batchId);
  if (batch.status !== 'previewed') throw new ServiceError('invalid_state', 'Only previewed batches can be remapped');
  const [att] = await s.tx.select().from(schema.attachments).where(eq(schema.attachments.id, batch.fileAttachmentId!));
  const obj = att ? await storage.getObject(att.objectKey) : null;
  if (!obj) throw new ServiceError('internal', 'Import file is missing from storage');
  const content = new TextDecoder().decode(obj.body);
  await s.tx.update(schema.importBatches).set({ status: 'discarded' }).where(eq(schema.importBatches.id, batchId));
  return previewCsv(s, storage, { bankAccountId: batch.bankAccountId, fileName: batch.fileName ?? 'import.csv', content, mapping });
}

/**
 * Commit: insert one bank transaction per `ok` row. Duplicate rows (already
 * imported) are skipped; a file already committed for this account is rejected;
 * row-level uniqueness on fingerprint is the database backstop.
 */
export async function commitBatch(s: ServiceContext, batchId: string, idempotencyKey?: string): Promise<ImportBatchDto> {
  return idempotent(s, idempotencyKey, { batchId }, async () => {
    const batch = await loadBatch(s, batchId);
    if (batch.status === 'committed') return getBatch(s, batchId);
    if (batch.status !== 'previewed') throw new ServiceError('invalid_state', `Batch is ${batch.status}`);
    if (!batch.mapping) throw new ServiceError('validation', 'Choose a column mapping before importing');
    const bankAccount = await getBankAccount(s, batch.bankAccountId);
    if (batch.fileSha256) {
      const [prior] = await s.tx
        .select({ id: schema.importBatches.id, committedAt: schema.importBatches.committedAt })
        .from(schema.importBatches)
        .where(and(eq(schema.importBatches.companyId, s.ctx.companyId), eq(schema.importBatches.bankAccountId, bankAccount.id), eq(schema.importBatches.fileSha256, batch.fileSha256), eq(schema.importBatches.status, 'committed')));
      if (prior) {
        throw new ServiceError('duplicate', `This exact file was already imported${prior.committedAt ? ` on ${plainDate(prior.committedAt)}` : ''}, so there is nothing new to import.`, { priorBatchId: prior.id });
      }
    }
    const rows = await s.tx.select().from(schema.importRows).where(eq(schema.importRows.batchId, batchId)).orderBy(asc(schema.importRows.rowNo));
    const okRows = rows.filter((r) => r.status === 'ok' && r.normalized && r.fingerprint);
    // Re-check duplicates at commit time (another import may have landed since preview).
    const fps = okRows.map((r) => r.fingerprint!);
    const existing = fps.length
      ? await s.tx
          .select({ id: schema.bankTransactions.id, fingerprint: schema.bankTransactions.fingerprint })
          .from(schema.bankTransactions)
          .where(and(eq(schema.bankTransactions.companyId, s.ctx.companyId), eq(schema.bankTransactions.bankAccountId, bankAccount.id), inArray(schema.bankTransactions.fingerprint, fps)))
      : [];
    const dupes = new Map(existing.map((e) => [e.fingerprint!, e.id]));
    const deleted = await deletedFingerprints(s, bankAccount.id, fps);
    let imported = 0;
    let duplicates = rows.filter((r) => r.status === 'duplicate').length;
    for (const r of okRows) {
      const n = r.normalized as { date: string; amount: string; description: string; memo: string | null; reference: string | null };
      if (dupes.has(r.fingerprint!)) {
        duplicates++;
        await s.tx.update(schema.importRows).set({ status: 'duplicate', duplicateOf: dupes.get(r.fingerprint!) }).where(eq(schema.importRows.id, r.id));
        continue;
      }
      if (deleted.has(r.fingerprint!)) {
        duplicates++;
        await s.tx.update(schema.importRows).set({ status: 'duplicate', error: DELETED_ROW_NOTE }).where(eq(schema.importRows.id, r.id));
        continue;
      }
      const [txn] = await s.tx
        .insert(schema.bankTransactions)
        .values({
          companyId: s.ctx.companyId,
          bankAccountId: bankAccount.id,
          source: 'csv',
          importBatchId: batchId,
          fingerprint: r.fingerprint,
          date: n.date,
          amount: n.amount,
          currency: bankAccount.currency,
          description: n.description || n.memo || '(no description)',
          memo: n.memo,
          reference: n.reference,
          raw: r.raw,
        })
        .returning({ id: schema.bankTransactions.id });
      await s.tx.update(schema.importRows).set({ bankTransactionId: txn!.id }).where(eq(schema.importRows.id, r.id));
      imported++;
    }
    const [updated] = await s.tx
      .update(schema.importBatches)
      .set({ status: 'committed', importedCount: imported, duplicateCount: duplicates, committedAt: new Date().toISOString() })
      .where(eq(schema.importBatches.id, batchId))
      .returning();
    await recordAudit(s, {
      action: 'import.committed',
      entityType: 'import_batch',
      entityId: batchId,
      details: { fileName: batch.fileName, imported, duplicates, errors: batch.errorCount },
    });
    return toBatchDto(updated!);
  });
}

export async function discardBatch(s: ServiceContext, batchId: string): Promise<void> {
  const batch = await loadBatch(s, batchId);
  if (batch.status !== 'previewed') throw new ServiceError('invalid_state', 'Only previewed batches can be discarded');
  await s.tx.update(schema.importBatches).set({ status: 'discarded' }).where(eq(schema.importBatches.id, batchId));
}

async function loadBatch(s: ServiceContext, id: string): Promise<BatchRow> {
  const [row] = await s.tx
    .select()
    .from(schema.importBatches)
    .where(and(eq(schema.importBatches.companyId, s.ctx.companyId), eq(schema.importBatches.id, id)))
    .limit(1);
  if (!row) throw notFound('Import batch');
  return row;
}

export async function getBatch(s: ServiceContext, id: string, withRows = true): Promise<ImportBatchDto> {
  const batch = await loadBatch(s, id);
  const dto = toBatchDto(batch);
  if (!withRows) return dto;
  const rows = await s.tx.select().from(schema.importRows).where(eq(schema.importRows.batchId, id)).orderBy(asc(schema.importRows.rowNo));
  const headers = rows[0] ? Object.keys(rows[0].raw as Record<string, string>) : [];
  return {
    ...dto,
    headers,
    rows: rows.map((r) =>
      toRowDto({
        rowNo: r.rowNo,
        raw: r.raw as Record<string, string>,
        normalized: r.normalized as PreviewRow['normalized'],
        fingerprint: r.fingerprint,
        status: r.status,
        error: r.error,
        duplicateOf: r.duplicateOf,
      }),
    ),
  };
}

export async function listBatches(s: ServiceContext, bankAccountId?: string): Promise<ImportBatchDto[]> {
  const conds = [eq(schema.importBatches.companyId, s.ctx.companyId)];
  if (bankAccountId) conds.push(eq(schema.importBatches.bankAccountId, bankAccountId));
  const rows = await s.tx
    .select()
    .from(schema.importBatches)
    .where(and(...conds))
    .orderBy(desc(schema.importBatches.createdAt))
    .limit(100);
  return rows.map((r) => toBatchDto(r));
}

function toBatchDto(b: BatchRow, headers?: string[]): ImportBatchDto {
  return {
    id: b.id,
    bankAccountId: b.bankAccountId,
    source: b.source,
    fileName: b.fileName,
    status: b.status,
    mapping: (b.mapping as CsvMapping | null) ?? null,
    headers,
    rowCount: b.rowCount,
    importedCount: b.importedCount,
    duplicateCount: b.duplicateCount,
    errorCount: b.errorCount,
    windowStart: b.windowStart,
    windowEnd: b.windowEnd,
    createdAt: b.createdAt,
    committedAt: b.committedAt,
  };
}

function toRowDto(r: PreviewRow): ImportRowDto {
  return {
    rowNo: r.rowNo,
    status: r.status,
    error: r.error,
    date: r.normalized?.date ?? null,
    amount: r.normalized?.amount ?? null,
    description: r.normalized?.description ?? null,
    memo: r.normalized?.memo ?? null,
    reference: r.normalized?.reference ?? null,
    duplicateOf: r.duplicateOf,
    raw: r.raw,
  };
}
