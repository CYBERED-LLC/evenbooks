/** Shared presentation types. No accounting values are configurable here. */
export interface InvoiceBranding {
  layout: 'classic' | 'modern';
  accentColor: string;
  paperSize: 'LETTER' | 'A4';
  showQuantity: boolean;
  showUnitPrice: boolean;
  showLineTax: boolean;
  logo: string | null;
  defaultFooter: string | null;
  defaultNotes: string | null;
  paymentInstructions: string | null;
}
export interface InvoiceEmailTemplate {
  subject: string;
  message: string;
  signature: string;
  replyTo: string | null;
}
export interface InvoicePresentation {
  branding: InvoiceBranding;
  email: InvoiceEmailTemplate;
}
export const DEFAULT_INVOICE_BRANDING: InvoiceBranding = {
  layout: 'classic',
  accentColor: '#1d4ed8',
  paperSize: 'LETTER',
  showQuantity: true,
  showUnitPrice: true,
  showLineTax: true,
  logo: null,
  defaultFooter: null,
  defaultNotes: null,
  paymentInstructions: null,
};
export const DEFAULT_INVOICE_EMAIL: InvoiceEmailTemplate = {
  subject: 'Invoice {{invoice_number}} from {{company_name}}',
  message: 'Hello {{customer_name}},\n\nPlease find attached invoice {{invoice_number}} for {{total}}, due {{due_date}}.',
  signature: '{{company_name}}',
  replyTo: null,
};
export const EMAIL_PLACEHOLDERS = [
  'customer_name',
  'company_name',
  'invoice_number',
  'issue_date',
  'due_date',
  'total',
  'balance_due',
  'invoice_url',
] as const;
export type EmailPlaceholder = (typeof EMAIL_PLACEHOLDERS)[number];
export function invalidTemplatePlaceholders(value: string): string[] {
  const unknown: string[] = [];
  for (const match of value.matchAll(/{{(.*?)}}/gs)) {
    if (!(EMAIL_PLACEHOLDERS as readonly string[]).includes(match[1]!.trim())) unknown.push(match[1]!);
  }
  if (value.replace(/{{.*?}}/gs, '').includes('{{') || value.replace(/{{.*?}}/gs, '').includes('}}')) unknown.push('unclosed placeholder');
  return unknown;
}
export function resolveEmailTemplate(value: string, vars: Record<EmailPlaceholder, string>): string {
  return value.replace(/{{\s*(\w+)\s*}}/g, (_, key: EmailPlaceholder) => vars[key] ?? '');
}
