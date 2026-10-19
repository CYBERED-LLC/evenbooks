import { z } from 'zod';
import { Uuid } from './common';

export const AttachmentKind = z.enum(['receipt', 'invoice_pdf', 'csv_import', 'other']);

export const AttachmentDto = z.object({
  id: z.string(),
  kind: AttachmentKind,
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string().nullable(),
  status: z.enum(['pending', 'uploaded', 'deleted']),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  createdAt: z.string(),
});
export type AttachmentDto = z.infer<typeof AttachmentDto>;

export const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'text/csv', 'text/plain'] as const;
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export const AttachInput = z.object({
  entityType: z.enum(['purchase', 'invoice', 'journal_entry', 'bank_transaction']),
  entityId: Uuid,
});

export const DownloadUrlDto = z.object({
  url: z.string(),
  expiresAt: z.string(),
});
export type DownloadUrlDto = z.infer<typeof DownloadUrlDto>;
