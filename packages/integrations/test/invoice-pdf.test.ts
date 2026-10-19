import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INVOICE_BRANDING, type InvoiceBranding } from '@evenbooks/domain';
import { renderInvoicePdf, type InvoicePdfData } from '../src/pdf';

function pdfText(pdf: Buffer): string {
  const texts: string[] = [];
  for (const stream of pdf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    let content: string;
    try { content = inflateSync(Buffer.from(stream[1]!, 'latin1')).toString('latin1'); }
    catch { continue; }
    for (const run of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      texts.push([...run[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((part) => Buffer.from(part[1]!, 'hex').toString('latin1')).join(''));
    }
  }
  return texts.join('\n');
}

function invoice(branding: InvoiceBranding): InvoicePdfData {
  return {
    number: 'INV-OPTIONS', status: 'issued', issueDate: '2026-10-01', dueDate: '2026-10-31',
    company: { name: 'Company', email: null, phone: null, address: {} },
    customer: { name: 'Customer', email: null }, currency: 'USD', branding,
    lines: [{ description: 'Services', quantity: '7', unitPrice: '17', lineDiscount: '0', net: '119', taxTotal: '6', total: '125' }],
    subtotal: '119', discountTotal: '0', taxSummary: [{ name: 'VAT', rate: '0.05', amount: '6' }], taxTotal: '6',
    total: '125', amountSettled: '0', balanceDue: '125', memo: null, footer: null,
  };
}

const choices = [false, true].flatMap((showQuantity) => [false, true].flatMap((showUnitPrice) =>
  [false, true].map((showLineTax) => ({ showQuantity, showUnitPrice, showLineTax })),
));

describe('invoice PDF row columns', () => {
  it.each(choices)('honors quantity=$showQuantity, price=$showUnitPrice, tax=$showLineTax while preserving totals', async (options) => {
    const text = pdfText(await renderInvoicePdf(invoice({ ...DEFAULT_INVOICE_BRANDING, ...options })));
    const lines = text.split('\n');
    expect(lines.includes('Qty')).toBe(options.showQuantity);
    expect(lines.includes('7')).toBe(options.showQuantity);
    expect(lines.includes('Unit price')).toBe(options.showUnitPrice);
    expect(lines.includes('$17.00')).toBe(options.showUnitPrice);
    expect(lines.includes('Tax')).toBe(options.showLineTax);
    expect(lines.filter((line) => line === '$6.00')).toHaveLength(options.showLineTax ? 2 : 1);
    expect(lines).toContain('Description');
    expect(lines).toContain('Amount');
    expect(lines).toContain('VAT (5%)');
    expect(lines).toContain('$119.00');
    expect(lines).toContain('$125.00');
  });

  it('keeps all columns visible for a saved design from before these settings existed', async () => {
    const legacy: Partial<InvoiceBranding> = { ...DEFAULT_INVOICE_BRANDING };
    delete legacy.showQuantity;
    delete legacy.showUnitPrice;
    delete legacy.showLineTax;
    const text = pdfText(await renderInvoicePdf(invoice(legacy as InvoiceBranding)));
    for (const label of ['Qty', 'Unit price', 'Tax']) expect(text.split('\n')).toContain(label);
  });
});
