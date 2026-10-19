import { randomUUID } from 'node:crypto';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { schema, withSystem, type Db } from '@evenbooks/db';
import type { ObjectStorage } from '@evenbooks/integrations';
import { ALLOWED_UPLOAD_TYPES, MAX_UPLOAD_BYTES, type AttachmentDto } from '@evenbooks/contracts';
import { ServiceError, notFound } from './errors';
import type { ServiceContext } from './context';
import { recordAudit } from './audit';

type AttachmentRow = typeof schema.attachments.$inferSelect;

export function toAttachmentDto(a: AttachmentRow): AttachmentDto {
  return {
    id: a.id,
    kind: a.kind,
    fileName: a.fileName,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    sha256: a.sha256,
    status: a.status,
    entityType: a.entityType,
    entityId: a.entityId,
    createdAt: a.createdAt,
  };
}

export function objectKey(companyId: string, kind: string, id: string, fileName: string): string {
  const ext = (fileName.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? 'bin').toLowerCase();
  return `companies/${companyId}/${kind}/${id}.${ext}`;
}

export interface UploadInput {
  kind: AttachmentRow['kind'];
  fileName: string;
  contentType: string;
  body: Uint8Array;
  entityType?: string | null;
  entityId?: string | null;
}

/** Records a file can be uploaded straight onto (e.g. "Attach receipt" on a saved expense). */
const ENTITY_TABLES = {
  purchase: { table: schema.purchases, label: 'Expense' },
  invoice: { table: schema.invoices, label: 'Invoice' },
  journal_entry: { table: schema.journalEntries, label: 'Journal entry' },
  bank_transaction: { table: schema.bankTransactions, label: 'Bank transaction' },
} as const;

/** The record a file is uploaded onto must exist in this company. */
async function assertEntity(s: ServiceContext, entityType: string, entityId: string): Promise<void> {
  const target = ENTITY_TABLES[entityType as keyof typeof ENTITY_TABLES];
  if (!target) throw new ServiceError('validation', 'Files can be attached to expenses, invoices, journal entries and bank transactions.');
  const { table } = target as { table: typeof schema.purchases };
  const [row] = await s.tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, s.ctx.companyId), eq(table.id, entityId)))
    .limit(1);
  if (!row) throw notFound(target.label);
}

/**
 * Store an uploaded file. Validates type/size, writes to company-scoped storage,
 * then records the attachment as `uploaded`. Called inside the company context.
 * With `entityType`/`entityId` the file is linked to that (existing) record at once.
 */
export async function uploadAttachment(s: ServiceContext, storage: ObjectStorage, input: UploadInput): Promise<AttachmentDto> {
  if (input.body.byteLength === 0) throw new ServiceError('validation', 'Empty file');
  if (!input.entityType !== !input.entityId) throw new ServiceError('validation', 'Give both the record type and its id, or neither.');
  if (input.entityType && input.entityId) await assertEntity(s, input.entityType, input.entityId);
  if (input.body.byteLength > MAX_UPLOAD_BYTES) throw new ServiceError('validation', `${input.fileName} is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Use a smaller file.`);
  if (input.kind !== 'invoice_pdf' && !(ALLOWED_UPLOAD_TYPES as readonly string[]).includes(input.contentType)) {
    throw new ServiceError('validation', `${input.fileName} can't be attached. Use a PDF or a photo (PNG, JPEG, WebP or HEIC).`);
  }
  const id = randomUUID();
  const key = objectKey(s.ctx.companyId, input.kind, id, input.fileName);
  // Record first as pending so an orphaned object can be cleaned up if the write fails half way.
  await s.tx.insert(schema.attachments).values({
    id,
    companyId: s.ctx.companyId,
    kind: input.kind,
    objectKey: key,
    fileName: input.fileName.slice(0, 255),
    contentType: input.contentType,
    sizeBytes: input.body.byteLength,
    status: 'pending',
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    uploadedBy: s.ctx.actorId,
  });
  const { sha256, size } = await storage.putObject(key, input.body, input.contentType);
  const [row] = await s.tx
    .update(schema.attachments)
    .set({ status: 'uploaded', sha256, sizeBytes: size, completedAt: new Date().toISOString() })
    .where(eq(schema.attachments.id, id))
    .returning();
  await recordAudit(s, { action: 'attachment.uploaded', entityType: 'attachment', entityId: id, details: { kind: input.kind, fileName: input.fileName, size } });
  return toAttachmentDto(row!);
}

export async function getAttachment(s: ServiceContext, id: string): Promise<AttachmentRow> {
  const [row] = await s.tx
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.companyId, s.ctx.companyId), eq(schema.attachments.id, id)))
    .limit(1);
  if (!row || row.status === 'deleted') throw notFound('Attachment');
  return row;
}

export async function listAttachmentsFor(s: ServiceContext, entityType: string, entityId: string): Promise<AttachmentDto[]> {
  const rows = await s.tx
    .select()
    .from(schema.attachments)
    .where(
      and(
        eq(schema.attachments.companyId, s.ctx.companyId),
        eq(schema.attachments.entityType, entityType),
        eq(schema.attachments.entityId, entityId),
        eq(schema.attachments.status, 'uploaded'),
      ),
    );
  return rows.map(toAttachmentDto);
}

/** Link uploaded attachments to an entity (only unlinked or same-entity ones). */
export async function attachTo(s: ServiceContext, ids: readonly string[], entityType: string, entityId: string): Promise<void> {
  if (ids.length === 0) return;
  const rows = await s.tx
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.companyId, s.ctx.companyId), inArray(schema.attachments.id, [...ids])));
  if (rows.length !== new Set(ids).size) throw new ServiceError('validation', 'Unknown attachment');
  for (const r of rows) {
    if (r.status !== 'uploaded') throw new ServiceError('validation', `Attachment ${r.fileName} is not uploaded`);
    if (r.entityId && r.entityId !== entityId) throw new ServiceError('validation', `Attachment ${r.fileName} is already linked to another record`);
  }
  await s.tx
    .update(schema.attachments)
    .set({ entityType, entityId })
    .where(and(eq(schema.attachments.companyId, s.ctx.companyId), inArray(schema.attachments.id, [...ids])));
}

/** Soft delete: the row is kept for audit, the object is removed. */
export async function deleteAttachment(s: ServiceContext, storage: ObjectStorage, id: string): Promise<void> {
  const row = await getAttachment(s, id);
  if (row.kind === 'invoice_pdf' || row.kind === 'csv_import') {
    throw new ServiceError('validation', 'Generated PDFs and import files are retained with their documents');
  }
  await s.tx.update(schema.attachments).set({ status: 'deleted', deletedAt: new Date().toISOString() }).where(eq(schema.attachments.id, id));
  await storage.deleteObject(row.objectKey);
  await recordAudit(s, { action: 'attachment.deleted', entityType: 'attachment', entityId: id, details: { fileName: row.fileName } });
}

/**
 * Orphan cleanup (worker job, system context): attachments still `pending` after
 * 24 hours, or `uploaded` but never linked to an entity after 7 days, are removed.
 * Retention: linked receipts/PDFs/import files are kept for the life of the record.
 */
export async function cleanupOrphanAttachments(db: Db, storage: ObjectStorage, now = new Date()): Promise<number> {
  const pendingCutoff = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const unlinkedCutoff = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  return withSystem(db, async (tx) => {
    const rows = await tx
      .select()
      .from(schema.attachments)
      .where(
        and(
          inArray(schema.attachments.status, ['pending', 'uploaded']),
          lt(schema.attachments.createdAt, unlinkedCutoff),
        ),
      );
    const stale = rows.filter((r) => r.entityId === null || (r.status === 'pending' && r.createdAt < pendingCutoff));
    for (const r of stale) {
      await storage.deleteObject(r.objectKey).catch(() => {});
      await tx.execute(
        // system context can read but not update tenant rows; use the company context per row
        (await import('drizzle-orm')).sql`select set_config('app.company_id', ${r.companyId}, true)`,
      );
      await tx.update(schema.attachments).set({ status: 'deleted', deletedAt: now.toISOString() }).where(eq(schema.attachments.id, r.id));
    }
    return stale.length;
  });
}
