import { DEFAULT_INVOICE_BRANDING, type InvoiceBranding } from '@evenbooks/domain';
import { invoiceLogoBytes } from './invoice-email-renderer';
import PDFDocument from 'pdfkit';

/**
 * Invoice PDF rendering with pdfkit (pure Node, no browser). Input is a fully
 * snapshotted document; nothing here reads live master data, so a regenerated
 * PDF for an issued invoice is byte-stable apart from the generation timestamp
 * (which we omit) — see the invoice PDF service for versioning.
 */
export interface PdfAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface InvoicePdfData {
  branding?: InvoiceBranding;
  number: string;
  status: 'issued' | 'paid' | 'void';
  issueDate: string;
  dueDate: string;
  company: { name: string; email?: string | null; phone?: string | null; address?: PdfAddress };
  customer: { name: string; email?: string | null; address?: PdfAddress };
  lines: { description: string; quantity: string; unitPrice: string; lineDiscount: string; total: string; net: string; taxTotal: string }[];
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxSummary: { name: string; rate: string; amount: string }[];
  taxTotal: string;
  total: string;
  amountSettled: string;
  balanceDue: string;
  memo?: string | null;
  footer?: string | null;
  paymentUrl?: string | null;
  publicUrl?: string | null;
}

function money(v: string, currency: string): string {
  const n = Number(v);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number.isFinite(n) ? n : 0);
}

function addressLines(a?: PdfAddress): string[] {
  if (!a) return [];
  const cityLine = [a.city, a.region].filter(Boolean).join(', ') + (a.postalCode ? ` ${a.postalCode}` : '');
  return [a.line1, a.line2, cityLine.trim(), a.country].filter((x): x is string => Boolean(x && x.trim()));
}

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const branding = { ...DEFAULT_INVOICE_BRANDING, ...data.branding };
  const doc = new PDFDocument({
    size: branding.paperSize,
    margin: 50,
    info: { Title: `Invoice ${data.number}`, Author: data.company.name, CreationDate: new Date(0), ModDate: new Date(0) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = 50;
  const right = doc.page.width - 50;
  const bottom = doc.page.height - 65;
  const accent = branding.accentColor;
  const modern = branding.layout === 'modern';
  if (modern) doc.rect(0, 0, doc.page.width, 8).fill(accent);
  let headerY = 50;
  if (branding.logo) {
    doc.image(invoiceLogoBytes(branding.logo).bytes, left, headerY, { fit: [150, 60] });
    headerY += 72;
  }
  // Header
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(modern ? accent : '#000')
    .text(data.company.name, left, headerY, { width: 300 });
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  let y = Math.max(headerY + 26, doc.y + 8);
  for (const l of addressLines(data.company.address)) {
    doc.text(l, left, y);
    y += 12;
  }
  if (data.company.email) {
    doc.text(data.company.email, left, y);
    y += 12;
  }
  if (data.company.phone) {
    doc.text(data.company.phone, left, y);
    y += 12;
  }
  doc
    .fillColor(modern ? accent : '#000')
    .font('Helvetica-Bold')
    .fontSize(24)
    .text('INVOICE', 380, 50, { width: right - 380, align: 'right' });
  doc.font('Helvetica').fontSize(10);
  const meta: [string, string][] = [
    ['Invoice #', data.number],
    ['Issue date', data.issueDate],
    ['Due date', data.dueDate],
    ['Status', data.status === 'void' ? 'VOID' : data.status === 'paid' ? 'PAID' : 'DUE'],
  ];
  let my = 84;
  for (const [k, v] of meta) {
    doc.fillColor('#666').text(k, 380, my, { width: 90, align: 'right' });
    doc.fillColor('#000').text(v, 475, my, { width: right - 475, align: 'right' });
    my += 14;
  }

  // Bill to
  y = Math.max(y, my) + 20;
  doc.fillColor('#666').fontSize(9).text('BILL TO', left, y);
  y += 12;
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(11).text(data.customer.name, left, y);
  y += 14;
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  for (const l of addressLines(data.customer.address)) {
    doc.text(l, left, y);
    y += 12;
  }
  if (data.customer.email) {
    doc.text(data.customer.email, left, y);
    y += 12;
  }

  // Table
  y += 18;
  const columns: { key: 'quantity' | 'unitPrice' | 'taxTotal' | 'net'; label: string; width: number; x: number }[] = [
    ...(branding.showQuantity ? [{ key: 'quantity' as const, label: 'Qty', width: 45, x: 0 }] : []),
    ...(branding.showUnitPrice ? [{ key: 'unitPrice' as const, label: 'Unit price', width: 70, x: 0 }] : []),
    ...(branding.showLineTax ? [{ key: 'taxTotal' as const, label: 'Tax', width: 60, x: 0 }] : []),
    { key: 'net', label: 'Amount', width: 80, x: 0 },
  ];
  let columnX = right - 6;
  for (const column of [...columns].reverse()) {
    columnX -= column.width;
    column.x = columnX;
    columnX -= 10;
  }
  const descriptionWidth = columnX - left;
  const tableHeader = () => {
    doc.rect(left, y, right - left, 18).fill(modern ? accent : '#f1f1f1');
    doc
      .fillColor(modern ? '#fff' : '#333')
      .font('Helvetica-Bold')
      .fontSize(9);
    doc.text('Description', left + 6, y + 5, { width: descriptionWidth });
    for (const column of columns)
      doc.text(column.label, column.x, y + 5, { width: column.width, align: 'right' });
    y += 22;
    doc.font('Helvetica').fontSize(9).fillColor('#000');
  };
  const newPage = () => {
    doc.addPage();
    y = 50;
  };
  const ensureSpace = (height: number) => {
    if (y + height > bottom) newPage();
  };
  tableHeader();
  for (const l of data.lines) {
    const h = Math.max(14, doc.heightOfString(l.description, { width: descriptionWidth }));
    if (y + h + 28 > bottom) {
      newPage();
      tableHeader();
    }
    doc.text(l.description, left + 6, y, { width: descriptionWidth });
    for (const column of columns)
      doc.text(column.key === 'quantity' ? l.quantity : money(l[column.key], data.currency), column.x, y, { width: column.width, align: 'right' });
    if (Number(l.lineDiscount) > 0) {
      y += h;
      doc.fillColor('#666').text(`Discount −${money(l.lineDiscount, data.currency)}`, left + 6, y, { width: descriptionWidth });
      doc.fillColor('#000');
      y += 12;
    } else {
      y += h + 4;
    }
    doc.moveTo(left, y).lineTo(right, y).strokeColor('#e5e5e5').stroke();
    y += 6;
  }

  // Totals
  const totals: [string, string, boolean][] = [['Subtotal', money(data.subtotal, data.currency), false]];
  if (Number(data.discountTotal) > 0) totals.push(['Discounts', `−${money(data.discountTotal, data.currency)}`, false]);
  for (const t of data.taxSummary)
    totals.push([`${t.name} (${(Number(t.rate) * 100).toFixed(2).replace(/\.?0+$/, '')}%)`, money(t.amount, data.currency), false]);
  totals.push(['Total', money(data.total, data.currency), true]);
  if (Number(data.amountSettled) > 0) totals.push(['Paid', `−${money(data.amountSettled, data.currency)}`, false]);
  totals.push(['Balance due', money(data.balanceDue, data.currency), true]);
  y += 6;
  ensureSpace(totals.length * 18 + 20);
  for (const [k, v, bold] of totals) {
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(bold ? 11 : 9)
      .fillColor(bold ? '#000' : '#444');
    doc.text(k, right - 182, y, { width: 100, align: 'right' });
    doc.text(v, right - 77, y, { width: 77, align: 'right' });
    y += bold ? 18 : 14;
  }

  // Notes
  y += 10;
  doc.font('Helvetica').fontSize(9).fillColor('#000');
  ensureSpace(45);
  if (data.paymentUrl) {
    doc.fillColor('#1a56db').text('Pay online: ' + data.paymentUrl, left, y, { link: data.paymentUrl, underline: true, width: 300 });
    doc.fillColor('#000');
    y += 16;
  }
  if (data.publicUrl) {
    doc.fillColor('#666').text('View this invoice online: ' + data.publicUrl, left, y, { link: data.publicUrl, width: 400 });
    doc.fillColor('#000');
    y += 16;
  }
  const note = (title: string | null, value: string | null | undefined, small = false) => {
    if (!value) return;
    doc.font('Helvetica').fontSize(small ? 8 : 9);
    if (title) {
      ensureSpace(40);
      doc.font('Helvetica-Bold').text(title, left, y);
      y += 14;
      doc.font('Helvetica');
    }
    // Render paragraph by paragraph, letting PDFKit flow long notes across pages.
    for (const line of value.split('\n')) {
      const h = doc.heightOfString(line || ' ', { width: right - left });
      ensureSpace(Math.min(h, bottom - 50));
      doc.fillColor(small ? '#666' : '#000').text(line || ' ', left, y, { width: right - left });
      y = doc.y + 6;
    }
    y += 10;
  };
  note('Payment instructions', branding.paymentInstructions);
  note('Notes', data.memo);
  note(null, data.footer, true);
  doc.end();
  return done;
}
