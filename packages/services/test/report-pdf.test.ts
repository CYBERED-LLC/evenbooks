import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pdfSafeText } from '@evenbooks/integrations';
import {
  balanceSheetPdf,
  categoryReportPdf,
  createContact,
  createDraftInvoice,
  createManualJournal,
  generalLedgerPdf,
  issueInvoice,
  outstandingInvoicesPdf,
  pdfPercentChange,
  profitAndLossPdf,
  renderReport,
  scheduleCPdf,
  transactionsPdf,
  trialBalancePdf,
  type ReportPdf,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
const generatedAt = new Date('2026-09-28T18:05:00Z');
const GL_ENTRIES = 140;

/** WinAnsi codes outside Latin-1 that the reports use. */
const WIN_ANSI: Record<number, string> = { 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—' };

/** Minimal text extraction: inflate every content stream and decode the hex strings pdfkit writes in TJ arrays. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const start = raw.indexOf('stream\n', at);
    if (start < 0) break;
    const end = raw.indexOf('\nendstream', start);
    if (end < 0) break;
    at = end + 10;
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start + 7, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const m of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      out.push([...m[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => [...Buffer.from(h[1]!, 'hex')].map((c) => WIN_ANSI[c] ?? String.fromCharCode(c)).join('')).join(''));
    }
  }
  return out.join('\n');
}

function pageCount(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
}

function mediaBox(pdf: Buffer): string | undefined {
  return pdf.toString('latin1').match(/\/MediaBox \[([^\]]+)\]/)?.[1]?.trim();
}

async function render(r: ReportPdf) {
  const pdf = await renderReport(r);
  if (process.env.REPORT_PDF_OUT) {
    mkdirSync(process.env.REPORT_PDF_OUT, { recursive: true });
    writeFileSync(path.join(process.env.REPORT_PDF_OUT, r.fileName), pdf);
  }
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const pages = pageCount(pdf);
  expect(pages).toBeGreaterThan(0);
  const text = pdfText(pdf);
  expect(text).toContain('Alpha LLC');
  expect(text).toContain(r.document.title);
  for (let i = 1; i <= pages; i++) expect(text).toContain(`Page ${i} of ${pages}`);
  return { pdf, pages, text };
}

const line = (code: string, side: 'debit' | 'credit', amount: string, memo?: string) => ({ accountId: acct.get(code)!, [side]: amount, memo: memo ?? null });

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  const post = (date: string, memo: string, lines: ReturnType<typeof line>[]) => w.run(w.ctxA, (s) => createManualJournal(s, { date, memo, cashTreatment: 'include', post: true, lines }));
  await post('2026-02-01', 'Owner funds the business', [line('1000', 'debit', '1000'), line('3000', 'credit', '1000')]);
  await post('2026-02-15', 'February sale', [line('1000', 'debit', '80.00'), line('4100', 'credit', '80.00')]);
  for (let i = 1; i <= 5; i++) await post(`2026-03-0${i}`, `Consulting sale ${i}`, [line('1000', 'debit', '100.10'), line('4100', 'credit', '100.10')]);
  await post('2026-03-10', 'Printer paper', [line('5110', 'debit', '25.00', 'Staples 100% recycled'), line('1000', 'credit', '25.00')]);
  // Enough April postings to push the general ledger and transactions report over several pages.
  for (let i = 1; i <= GL_ENTRIES; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    await post(`2026-04-${day}`, `Supplies run ${i}`, [line('5110', 'debit', `${i}.25`), line('1000', 'credit', `${i}.25`)]);
  }
  const customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Zoë Café SARL', isCustomer: true, isVendor: false }))).id;
  for (const issueDate of ['2026-05-01', '2026-06-20']) {
    const draft = await w.run(w.ctxA, (s) =>
      createDraftInvoice(s, {
        contactId: customerId,
        issueDate,
        lines: [{ description: 'Consulting', quantity: '1', unitPrice: '300.00', discount: null, incomeAccountId: acct.get('4100')!, taxRateIds: [] }],
        documentDiscount: null,
      }),
    );
    await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
  }
}, 180_000);
afterAll(async () => {
  await w.destroy();
});

describe('report PDFs', () => {
  it('profit and loss, with and without comparison columns', async () => {
    const plain = await w.run(w.ctxA, (s) => profitAndLossPdf(s, { from: '2026-03-01', to: '2026-03-31', basis: 'accrual' }, { generatedAt }));
    expect(plain.fileName).toBe('profit-and-loss-accrual-2026-03-01-2026-03-31.pdf');
    expect(plain.document.orientation).toBe('portrait');
    const a = await render(plain);
    expect(a.text).toContain('Mar 1, 2026 – Mar 31, 2026');
    expect(a.text).toContain('Accrual basis');
    expect(a.text).toContain('Generated Sep 28, 2026, 2:05 PM (America/New_York)');
    expect(a.text).toContain('Net income');
    expect(a.text).toContain('$500.50');
    expect(a.text).not.toContain('Prior');

    const cmp = await w.run(w.ctxA, (s) => profitAndLossPdf(s, { from: '2026-03-01', to: '2026-03-31', basis: 'accrual', compareFrom: '2026-02-01', compareTo: '2026-02-28' }, { generatedAt }));
    const b = await render(cmp);
    expect(b.text).toContain('Compared with Feb 1, 2026 – Feb 28, 2026');
    for (const h of ['Prior', 'Change', '%']) expect(b.text).toContain(h);
    // Income 500.50 vs 80.00: change 420.50, +525.6%.
    expect(b.text).toContain('$420.50');
    expect(b.text).toContain('+525.6%');
  });

  it('balance sheet, trial balance, category report and Schedule C', async () => {
    const bs = await render(await w.run(w.ctxA, (s) => balanceSheetPdf(s, { asOf: '2026-03-31', compareAsOf: '2026-02-28' }, { generatedAt })));
    expect(bs.text).toContain('As of Mar 31, 2026');
    expect(bs.text).toContain('Total liabilities and equity');
    expect(bs.text).toContain('Prior');

    const tb = await render(await w.run(w.ctxA, (s) => trialBalancePdf(s, { asOf: '2026-03-31' }, { generatedAt })));
    expect(tb.text).toContain('Debits equal credits');
    expect(tb.text).toContain('As of Mar 31, 2026');
    expect(tb.text).not.toContain('Opening');
    expect(tb.text).not.toContain('Closing');

    const cat = await w.run(w.ctxA, (s) => categoryReportPdf(s, { from: '2026-03-01', to: '2026-03-31', basis: 'cash', compareFrom: '2026-02-01', compareTo: '2026-02-28' }, { generatedAt }));
    expect(cat.fileName).toBe('categories-cash-2026-03-01-2026-03-31.pdf');
    const c = await render(cat);
    expect(c.text).toContain('Cash basis');
    expect(c.text).toContain('Transactions');

    const sc = await w.run(w.ctxA, (s) => scheduleCPdf(s, { taxYear: 2026, basis: 'accrual' }, { generatedAt }));
    expect(sc.fileName).toBe('schedule-c-2026-accrual.pdf');
    const scr = await render(sc);
    expect(scr.text).toContain('Tax year 2026');
    expect(scr.text).toContain('Tentative profit');
    expect(scr.text).toContain('not tax advice');
  });

  it('general ledger includes every line on several landscape pages, header repeated on each', async () => {
    const r = await w.run(w.ctxA, (s) => generalLedgerPdf(s, { accountId: acct.get('1000')!, from: '2026-04-01', to: '2026-04-30' }, { generatedAt }));
    expect(r.fileName).toBe('general-ledger-1000-2026-04-01-2026-04-30.pdf');
    expect(r.document.orientation).toBe('landscape');
    const { pdf, pages, text } = await render(r);
    expect(mediaBox(pdf)).toBe('0 0 792 612');
    expect(pages).toBeGreaterThan(2);
    for (let i = 1; i <= GL_ENTRIES; i++) expect(text).toContain(`Supplies run ${i}\n`);
    expect(text).toContain('Opening balance');
    expect(text).toContain('Closing balance');
    // The column header ("Balance") repeats on every page; continuation pages say so.
    expect(text.split('\n').filter((t) => t === 'Balance').length).toBeGreaterThanOrEqual(pages);
    expect(text.split('\n').filter((t) => t.endsWith('General ledger (continued)')).length).toBe(pages - 1);
  });

  it('transactions report exports every matching row with its filters in the subtitle', async () => {
    const all = await w.run(w.ctxA, (s) => transactionsPdf(s, { from: '2026-04-01', to: '2026-04-30' }, { generatedAt }));
    expect(all.fileName).toBe('transactions-2026-04-01-2026-04-30.pdf');
    const a = await render(all);
    expect(mediaBox(a.pdf)).toBe('0 0 792 612');
    expect(a.pages).toBeGreaterThan(3);
    expect(a.text).toContain(`Total · ${GL_ENTRIES * 2} lines`);

    const filtered = await w.run(w.ctxA, (s) => transactionsPdf(s, { from: '2026-03-01', to: '2026-03-31', accountId: acct.get('5110')!, q: 'paper' }, { generatedAt }));
    const f = await render(filtered);
    expect(f.text).toMatch(/Account: 5110 /);
    expect(f.text).toContain('Memo contains "paper"');
    expect(f.text).toContain('Staples 100% recycled');
    expect(f.text).toContain('Total · 1 line');
  });

  it('outstanding invoices with aging tiles, bucket filter and customer grouping', async () => {
    const r = await w.run(w.ctxA, (s) => outstandingInvoicesPdf(s, { asOf: '2026-07-15', group: 'customer' }, { generatedAt }));
    expect(r.fileName).toBe('outstanding-invoices-2026-07-15.pdf');
    const o = await render(r);
    expect(o.text).toContain('TOTAL OUTSTANDING');
    expect(o.text).toContain('$600.00');
    // Non-WinAnsi characters are mapped rather than garbled; accents inside Latin-1 survive.
    expect(o.text).toContain('Zoë Café SARL subtotal');
    expect(o.text).toContain('By customer');

    const current = await w.run(w.ctxA, (s) => outstandingInvoicesPdf(s, { asOf: '2026-07-15', bucket: 'current' }, { generatedAt }));
    const c = await render(current);
    expect(c.text).toContain('Current only');
  });
});

describe('PDF helpers', () => {
  it('maps text to the standard font encoding', () => {
    expect(pdfSafeText('−12 – ok')).toBe('-12 – ok');
    expect(pdfSafeText('Łódź 東京')).toBe('?ódz ??');
    expect(pdfSafeText('Café')).toBe('Café');
  });
  it('computes percent change like the screen', () => {
    expect(pdfPercentChange('500.50', '80.00', 'USD')).toBe('+525.6%');
    expect(pdfPercentChange('50.00', '100.00', 'USD')).toBe('-50.0%');
    expect(pdfPercentChange('10.00', '0.00', 'USD')).toBeNull();
    expect(pdfPercentChange(null, '-20.00', 'USD')).toBe('+100.0%');
  });
});
