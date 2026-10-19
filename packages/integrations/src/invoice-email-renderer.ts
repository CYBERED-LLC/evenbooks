import { Money, resolveEmailTemplate, type EmailPlaceholder, type InvoicePresentation } from '@evenbooks/domain';

export function escapeEmailHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function safeEmailUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
export interface InvoiceEmailData {
  number: string;
  customerName: string;
  companyName: string;
  issueDate: string;
  dueDate: string;
  total: string;
  balanceDue: string;
  currency: string;
  invoiceUrl: string | null;
  paymentUrl: string | null;
}
export function renderInvoiceEmail(
  data: InvoiceEmailData,
  presentation: InvoicePresentation,
  overrides: { subject?: string; message?: string | null; preview?: boolean } = {},
) {
  const fmt = (v: string) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: data.currency }).format(Number(Money.round(v, data.currency).toString()));
  const link = safeEmailUrl(data.invoiceUrl);
  const pay = safeEmailUrl(data.paymentUrl);
  const vars: Record<EmailPlaceholder, string> = {
    customer_name: data.customerName,
    company_name: data.companyName,
    invoice_number: data.number,
    issue_date: data.issueDate,
    due_date: data.dueDate,
    total: fmt(data.total),
    balance_due: fmt(data.balanceDue),
    invoice_url: link ?? '',
  };
  const subject = (overrides.subject ?? resolveEmailTemplate(presentation.email.subject, vars)).replace(/[\r\n]/g, ' ').slice(0, 998);
  const message = overrides.message ?? resolveEmailTemplate(presentation.email.message, vars);
  const signature = resolveEmailTemplate(presentation.email.signature, vars);
  const esc = escapeEmailHtml;
  const paragraph = (v: string) => esc(v).replace(/\n/g, '<br>');
  const color = /^#[0-9a-f]{6}$/i.test(presentation.branding.accentColor) ? presentation.branding.accentColor : '#1d4ed8';
  const logo = presentation.branding.logo
    ? `<img src="${overrides.preview ? presentation.branding.logo : 'cid:company-logo'}" alt="${esc(data.companyName)}" width="120" style="max-width:120px;max-height:72px;object-fit:contain;margin-bottom:16px">`
    : '';
  const instructions = presentation.branding.paymentInstructions;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:Arial,sans-serif;color:#292524"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:white;border-top:5px solid ${color}"><tr><td style="padding:32px">${logo}<p style="font-size:20px;font-weight:bold;margin:0 0 24px">${esc(data.companyName)}</p><p style="line-height:1.6">${paragraph(message)}</p><table role="presentation" width="100%" style="background:#fafaf9;margin:24px 0;padding:16px"><tr><td>Invoice</td><td align="right">${esc(data.number)}</td></tr><tr><td>Due date</td><td align="right">${esc(data.dueDate)}</td></tr><tr><td style="padding-top:12px;font-weight:bold">Balance due</td><td align="right" style="padding-top:12px;font-weight:bold">${esc(vars.balance_due)}</td></tr></table>${pay ? `<p><a href="${esc(pay)}" style="display:inline-block;padding:12px 20px;background:${color};color:white;border-radius:6px;text-decoration:none;font-weight:bold">Pay online</a></p>` : ''}${link ? `<p><a href="${esc(link)}" style="color:${color}">View the invoice online</a></p>` : ''}${instructions ? `<p style="line-height:1.6">${paragraph(instructions)}</p>` : ''}<p>Your invoice PDF is attached.</p><p style="line-height:1.6;margin-top:28px">${paragraph(signature)}</p></td></tr></table></td></tr></table></body></html>`;
  const text = [
    message,
    '',
    `Invoice: ${data.number}`,
    `Due date: ${data.dueDate}`,
    `Balance due: ${vars.balance_due}`,
    link ? `View the invoice online: ${link}` : '',
    pay ? `Pay online: ${pay}` : '',
    instructions ?? '',
    '',
    'Your invoice PDF is attached.',
    '',
    signature,
  ]
    .filter((v, i, a) => v !== '' || a[i - 1] !== '')
    .join('\n');
  return { subject, message, text, html };
}

/** Validate actual raster bytes and cap dimensions before decoding in PDFKit. */
export function invoiceLogoBytes(logo: string): { bytes: Buffer; contentType: string } {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+=*)$/.exec(logo);
  if (!match) throw new Error('Upload a PNG or JPEG logo');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length > 256_000) throw new Error('Keep the logo under 250 KB');
  let width = 0,
    height = 0;
  if (
    match[1] === 'png' &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (match[1] === 'jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 4 < bytes.length) {
      if (bytes[at] !== 255) break;
      const marker = bytes[at + 1]!;
      const length = bytes.readUInt16BE(at + 2);
      if (length < 2 || at + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(at + 5);
        width = bytes.readUInt16BE(at + 7);
        break;
      }
      at += length + 2;
    }
  }
  if (!width || !height || width > 4000 || height > 4000 || width * height > 8_000_000)
    throw new Error('Use a valid PNG or JPEG logo no larger than 4,000 pixels per side');
  return { bytes, contentType: `image/${match[1]}` };
}
