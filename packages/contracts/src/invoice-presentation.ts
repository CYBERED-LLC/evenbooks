import { z } from 'zod';
import { invalidTemplatePlaceholders } from '@evenbooks/domain';

const template = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => invalidTemplatePlaceholders(s).length === 0, 'Use a supported placeholder, such as {{invoice_number}}');
export const InvoiceBrandingInput = z.object({
  layout: z.enum(['classic', 'modern']),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex color'),
  paperSize: z.enum(['LETTER', 'A4']),
  showQuantity: z.boolean().default(true),
  showUnitPrice: z.boolean().default(true),
  showLineTax: z.boolean().default(true),
  logo: z
    .string()
    .max(350_000)
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/, 'Upload a PNG or JPEG logo')
    .nullable(),
  defaultFooter: z.string().max(2000).nullable(),
  defaultNotes: z.string().max(2000).nullable(),
  paymentInstructions: z.string().max(2000).nullable(),
});
export const InvoiceEmailTemplateInput = z.object({
  subject: template(250).refine((s) => s.trim().length > 0 && !/[\r\n]/.test(s), 'Enter a subject on one line'),
  message: template(5000),
  signature: template(2000),
  replyTo: z.email().nullable(),
});
export const InvoicePresentationInput = z.object({ branding: InvoiceBrandingInput, email: InvoiceEmailTemplateInput });
export const UpdateInvoicePresentationInput = InvoicePresentationInput.extend({ version: z.number().int().nonnegative() });
export type UpdateInvoicePresentationInput = z.infer<typeof UpdateInvoicePresentationInput>;
export const InvoicePresentationDto = InvoicePresentationInput.extend({ version: z.number().int().nonnegative() });
export type InvoicePresentationDto = z.infer<typeof InvoicePresentationDto>;
export const InvoiceEmailPreviewInput = z.object({
  invoiceId: z.uuid().optional(),
  subject: z
    .string()
    .max(250)
    .refine((s) => !/[\r\n]/.test(s))
    .optional(),
  message: z.string().max(5000).nullable().optional(),
  presentation: InvoicePresentationInput.optional(),
  usePlatformSender: z.boolean().optional(),
});
export const TestInvoiceEmailInput = InvoicePresentationInput.extend({ to: z.email(), idempotencyKey: z.string().min(1).max(200) });
export const SenderSetupInput = z
  .object({
    domain: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter your company domain, such as example.com'),
    fromEmail: z.email().max(254),
    fromName: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((s) => !/[\r\n<>]/.test(s), 'Enter a sender name without angle brackets or line breaks'),
  })
  .refine((v) => v.fromEmail.split('@')[1]?.toLowerCase() === v.domain, 'The sender address must belong to this domain');
export const SenderIdentityDto = z.object({
  id: z.string(),
  domain: z.string(),
  fromEmail: z.string(),
  fromName: z.string(),
  status: z.enum(['pending', 'verified', 'failed', 'disabled']),
  active: z.boolean(),
  checkedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  records: z.array(z.object({ name: z.string(), type: z.enum(['TXT', 'CNAME']), value: z.string(), purpose: z.string() })),
});
export type SenderIdentityDto = z.infer<typeof SenderIdentityDto>;
