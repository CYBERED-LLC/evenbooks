import PDFDocument from 'pdfkit';

/**
 * Generic report PDF renderer (pdfkit, pure Node, standard Helvetica so no font
 * files are needed). Callers pass fully formatted strings; nothing here knows
 * about accounting. Layout: company name, report title, subtitle lines and a
 * generated-on line on the first page; optional summary tiles and alerts; one
 * or more tables whose header row repeats on every page; notes; and a footer
 * with "Page X of N" on every page.
 */

export type ReportPdfCell =
  | string
  | {
      text: string;
      /** Second, smaller muted line under the text (e.g. a line memo). */
      sub?: string;
      /** Number of columns this cell covers (default 1). */
      span?: number;
      bold?: boolean;
      muted?: boolean;
      italic?: boolean;
      tone?: 'danger' | 'warning';
      /** Extra left indent in points (nested account rows). */
      indent?: number;
    };

export interface ReportPdfColumn {
  header: string;
  /** Relative width; columns are scaled to fill the page width. */
  weight: number;
  align?: 'left' | 'right';
}

export type ReportPdfRow =
  | { kind: 'section'; label: string; tone?: 'warning' }
  | { kind: 'line'; cells: ReportPdfCell[]; muted?: boolean }
  | { kind: 'subtotal'; cells: ReportPdfCell[] }
  | { kind: 'total'; cells: ReportPdfCell[] }
  | { kind: 'empty'; text: string };

export interface ReportPdfTable {
  /** Optional heading printed above the table (and on continuation pages). */
  heading?: string;
  columns: ReportPdfColumn[];
  rows: ReportPdfRow[];
}

export interface ReportPdfDocument {
  companyName: string;
  title: string;
  /** Period, basis, comparison, filters: each a short phrase, joined with " · ". */
  subtitle: string[];
  /** Preformatted, e.g. "Generated Sep 28, 2026, 2:05 PM (America/New_York)". */
  generatedLine: string;
  generatedAt: Date;
  orientation: 'portrait' | 'landscape';
  summary?: { label: string; value: string; hint?: string; tone?: 'danger' }[];
  alerts?: string[];
  tables: ReportPdfTable[];
  notes?: string[];
}

// Print palette: warm neutrals from the Ledger theme; ink on white paper.
const INK = '#1c1915';
const MUTED = '#6b645a';
const FAINT = '#a39d93';
const RULE = '#d9d4ca';
const HAIRLINE = '#ebe7df';
const HEAD_BG = '#f3f0e8';
const TOTAL_BG = '#f7f5ef';
const DANGER = '#b42318';
const WARNING = '#9a5b00';

const MARGIN = 40;
const FOOTER_H = 26;
const PAD_X = 4;
const PAD_Y = 3.5;
const BODY_SIZE = 8.5;
const SUB_SIZE = 7;
const HEAD_SIZE = 7.5;

/** Characters Helvetica (WinAnsi) can encode beyond Latin-1. */
const WIN_ANSI_EXTRA = new Set([338, 339, 352, 353, 376, 381, 382, 402, 710, 732, 8211, 8212, 8216, 8217, 8218, 8220, 8221, 8222, 8224, 8225, 8226, 8230, 8240, 8249, 8250, 8364, 8482]);

/** Map text to what the standard fonts can draw: the math minus becomes "-", accents are stripped, the rest becomes "?". */
export function pdfSafeText(s: string): string {
  let out = '';
  for (const ch of s.replace(/\u2212/g, '-').replace(/[\u2007\u2009\u202f]/g, ' ')) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(c)) {
      out += ch;
      continue;
    }
    if (c < 0x20) {
      out += ' ';
      continue;
    }
    const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    out += base && [...base].every((b) => b.codePointAt(0)! < 0x7f) ? base : '?';
  }
  return out;
}

interface CellOpts {
  text: string;
  sub?: string;
  span: number;
  bold: boolean;
  muted: boolean;
  italic: boolean;
  tone?: 'danger' | 'warning';
  indent: number;
}

function normCell(c: ReportPdfCell, rowBold: boolean, rowMuted: boolean): CellOpts {
  if (typeof c === 'string') return { text: c, span: 1, bold: rowBold, muted: rowMuted, italic: false, indent: 0 };
  return { text: c.text, sub: c.sub, span: Math.max(1, c.span ?? 1), bold: c.bold ?? rowBold, muted: c.muted ?? rowMuted, italic: c.italic ?? false, tone: c.tone, indent: c.indent ?? 0 };
}

function fontName(bold: boolean, italic: boolean): string {
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/**
 * Draw one line of text that never wraps: the size shrinks (down to 70%) until it
 * fits the width, and anything still too long is cut with an ellipsis.
 */
function singleLine(
  doc: PDFKit.PDFDocument,
  raw: string,
  x: number,
  y: number,
  width: number,
  o: { font: string; size: number; color: string; align?: 'left' | 'right'; characterSpacing?: number },
) {
  const cs = o.characterSpacing ?? 0;
  let size = o.size;
  let text = raw;
  const measure = () => doc.font(o.font).fontSize(size).widthOfString(text, { characterSpacing: cs });
  while (measure() > width && size > o.size * 0.7) size -= 0.25;
  if (measure() > width) {
    while (text.length > 1 && doc.widthOfString(`${text}…`, { characterSpacing: cs }) > width) text = text.slice(0, -1);
    text = `${text.trimEnd()}…`;
  }
  doc.fillColor(o.color).text(text, x, y, { width, align: o.align ?? 'left', lineBreak: false, characterSpacing: cs });
}

export async function renderReportPdf(data: ReportPdfDocument): Promise<Buffer> {
  const layout = data.orientation;
  const margins = { top: MARGIN, left: MARGIN, right: MARGIN, bottom: 0 };
  const doc = new PDFDocument({
    size: 'LETTER',
    layout,
    margins,
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: pdfSafeText(`${data.title} - ${data.companyName}`), Author: pdfSafeText(data.companyName), Creator: 'Evenbooks', Producer: 'Evenbooks', CreationDate: data.generatedAt, ModDate: data.generatedAt },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageW = doc.page.width;
  const pageH = doc.page.height;
  const left = MARGIN;
  const right = pageW - MARGIN;
  const contentW = right - left;
  const bottom = pageH - MARGIN - FOOTER_H + 10;
  const T = pdfSafeText;

  let y = MARGIN;

  // ---- First-page header ----------------------------------------------------
  singleLine(doc, T(data.companyName), left, y, contentW, { font: 'Helvetica-Bold', size: 10, color: MUTED });
  y += 15;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(T(data.title), left, y, { width: contentW });
  y += doc.heightOfString(T(data.title), { width: contentW }) + 3;
  if (data.subtitle.length > 0) {
    const sub = T(data.subtitle.join('  ·  '));
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(sub, left, y, { width: contentW });
    y += doc.heightOfString(sub, { width: contentW }) + 2;
  }
  singleLine(doc, T(data.generatedLine), left, y, contentW, { font: 'Helvetica', size: 7.5, color: MUTED });
  y += 13;
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor(INK).stroke();
  y += 12;

  // ---- Summary tiles --------------------------------------------------------
  if (data.summary && data.summary.length > 0) {
    const gap = 8;
    const n = data.summary.length;
    const tileW = (contentW - gap * (n - 1)) / n;
    const tileH = data.summary.some((t) => t.hint) ? 42 : 32;
    data.summary.forEach((t, i) => {
      const x = left + i * (tileW + gap);
      doc.roundedRect(x, y, tileW, tileH, 3).lineWidth(0.75).strokeColor(RULE).stroke();
      singleLine(doc, T(t.label.toUpperCase()), x + 6, y + 6, tileW - 12, { font: 'Helvetica-Bold', size: 6.5, color: MUTED, characterSpacing: 0.3 });
      singleLine(doc, T(t.value), x + 6, y + 16, tileW - 12, { font: 'Helvetica-Bold', size: n > 4 ? 10 : 11.5, color: t.tone === 'danger' ? DANGER : INK });
      if (t.hint) singleLine(doc, T(t.hint), x + 6, y + 30, tileW - 12, { font: 'Helvetica', size: 6.5, color: MUTED });
    });
    y += tileH + 12;
  }

  // ---- Alerts ---------------------------------------------------------------
  for (const a of data.alerts ?? []) {
    const text = T(a);
    doc.font('Helvetica-Bold').fontSize(8.5);
    const h = doc.heightOfString(text, { width: contentW - 16 }) + 10;
    doc.rect(left, y, 2.5, h).fill(WARNING);
    doc.fillColor(WARNING).text(text, left + 10, y + 5, { width: contentW - 16 });
    y += h + 8;
  }

  // ---- Tables ---------------------------------------------------------------
  const continuation = () => {
    doc.addPage({ size: 'LETTER', layout, margins });
    y = MARGIN;
    singleLine(doc, T(`${data.companyName}  ·  ${data.title} (continued)`), left, y, contentW, { font: 'Helvetica', size: 7.5, color: MUTED });
    y += 16;
  };

  for (const table of data.tables) {
    const totalWeight = table.columns.reduce((n, c) => n + c.weight, 0) || 1;
    const widths = table.columns.map((c) => (c.weight / totalWeight) * contentW);
    const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((n, w) => n + w, 0));

    const headerH = (() => {
      doc.font('Helvetica-Bold').fontSize(HEAD_SIZE);
      return Math.max(...table.columns.map((c, i) => doc.heightOfString(T(c.header), { width: widths[i]! - PAD_X * 2 }))) + PAD_Y * 2 + 1;
    })();
    const headingH = table.heading ? 18 : 0;

    const drawHeader = () => {
      if (table.heading) {
        singleLine(doc, T(table.heading), left, y, contentW, { font: 'Helvetica-Bold', size: 10, color: INK });
        y += headingH;
      }
      doc.rect(left, y, contentW, headerH).fill(HEAD_BG);
      doc.font('Helvetica-Bold').fontSize(HEAD_SIZE).fillColor(MUTED);
      table.columns.forEach((c, i) => {
        doc.text(T(c.header), xs[i]! + PAD_X, y + PAD_Y + 0.5, { width: widths[i]! - PAD_X * 2, align: c.align ?? 'left' });
      });
      y += headerH;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.75).strokeColor(RULE).stroke();
    };

    /** Lay out a cell row: resolved cells with x/width and the row height. */
    const measure = (cells: ReportPdfCell[], bold: boolean, muted: boolean) => {
      const placed: (CellOpts & { x: number; w: number; align: 'left' | 'right' })[] = [];
      let col = 0;
      for (const raw of cells) {
        if (col >= table.columns.length) break;
        const c = normCell(raw, bold, muted);
        const span = Math.min(c.span, table.columns.length - col);
        const w = widths.slice(col, col + span).reduce((n, v) => n + v, 0);
        // A spanning cell takes the alignment of its last column only when every covered column is numeric.
        const align = table.columns.slice(col, col + span).every((x) => x.align === 'right') ? 'right' : (table.columns[col]!.align ?? 'left');
        placed.push({ ...c, x: xs[col]!, w, align, span });
        col += span;
      }
      let h = 0;
      for (const c of placed) {
        const inner = c.w - PAD_X * 2 - c.indent;
        doc.font(fontName(c.bold, c.italic)).fontSize(BODY_SIZE);
        // Figures never wrap (they shrink to fit instead); text wraps inside its column.
        let ch = c.align === 'right' && !c.sub ? doc.currentLineHeight(true) : doc.heightOfString(T(c.text) || ' ', { width: inner });
        if (c.sub) {
          doc.font('Helvetica').fontSize(SUB_SIZE);
          ch += doc.heightOfString(T(c.sub), { width: inner }) + 1;
        }
        h = Math.max(h, ch);
      }
      return { placed, h: h + PAD_Y * 2 };
    };

    const drawCells = (placed: ReturnType<typeof measure>['placed'], top: number) => {
      for (const c of placed) {
        const inner = c.w - PAD_X * 2 - c.indent;
        const color = c.tone === 'danger' ? DANGER : c.tone === 'warning' ? WARNING : c.muted ? MUTED : INK;
        const text = T(c.text);
        if (c.align === 'right' && !c.sub) {
          singleLine(doc, text, c.x + PAD_X + c.indent, top + PAD_Y, inner, { font: fontName(c.bold, c.italic), size: BODY_SIZE, color, align: 'right' });
          continue;
        }
        doc.font(fontName(c.bold, c.italic)).fontSize(BODY_SIZE).fillColor(color);
        doc.text(text, c.x + PAD_X + c.indent, top + PAD_Y, { width: inner, align: c.align });
        if (c.sub) {
          const th = doc.heightOfString(text || ' ', { width: inner });
          doc.font('Helvetica').fontSize(SUB_SIZE).fillColor(MUTED).text(T(c.sub), c.x + PAD_X + c.indent, top + PAD_Y + th + 1, { width: inner, align: c.align });
        }
      }
    };

    // Keep the table heading and header with at least one row.
    if (y + headingH + headerH + 18 > bottom) continuation();
    drawHeader();

    const ensure = (h: number) => {
      if (y + h <= bottom) return;
      continuation();
      drawHeader();
    };

    table.rows.forEach((row, idx) => {
      if (row.kind === 'section') {
        const h = 20;
        // Keep a section title with its first row.
        const next = table.rows[idx + 1];
        const nextH = next && next.kind !== 'section' && next.kind !== 'empty' ? measure(next.cells, false, false).h : 16;
        ensure(h + nextH);
        singleLine(doc, T(row.label.toUpperCase()), left + PAD_X, y + 9, contentW - PAD_X * 2, { font: 'Helvetica-Bold', size: 7.5, color: row.tone === 'warning' ? WARNING : MUTED, characterSpacing: 0.4 });
        y += h;
        return;
      }
      if (row.kind === 'empty') {
        const h = 16;
        ensure(h);
        const ex = xs[Math.min(1, xs.length - 1)]! + PAD_X;
        singleLine(doc, T(row.text), ex, y + PAD_Y, right - ex - PAD_X, { font: 'Helvetica-Oblique', size: BODY_SIZE, color: FAINT });
        y += h;
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(HAIRLINE).stroke();
        return;
      }
      const bold = row.kind !== 'line';
      const { placed, h } = measure(row.cells, bold, row.kind === 'line' && !!row.muted);
      const rowH = row.kind === 'total' ? h + 2 : h;
      ensure(rowH);
      if (row.kind === 'total') {
        doc.rect(left, y, contentW, rowH).fill(TOTAL_BG);
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.9).strokeColor(INK).stroke();
      } else if (row.kind === 'subtotal') {
        doc.moveTo(left, y).lineTo(right, y).lineWidth(0.6).strokeColor(RULE).stroke();
      }
      drawCells(placed, row.kind === 'total' ? y + 1 : y);
      y += rowH;
      if (row.kind === 'line') doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(HAIRLINE).stroke();
      if (row.kind === 'total') doc.moveTo(left, y).lineTo(right, y).lineWidth(0.9).strokeColor(INK).stroke();
    });
    y += 16;
  }

  // ---- Notes ----------------------------------------------------------------
  for (const n of data.notes ?? []) {
    const text = T(n);
    doc.font('Helvetica').fontSize(7.5);
    const h = doc.heightOfString(text, { width: contentW });
    if (y + h > bottom) continuation();
    doc.fillColor(MUTED).text(text, left, y, { width: contentW });
    y += h + 5;
  }

  // ---- Footers (every page, once the page count is known) --------------------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const fy = pageH - MARGIN + 6;
    doc.moveTo(left, fy - 6).lineTo(right, fy - 6).lineWidth(0.5).strokeColor(RULE).stroke();
    singleLine(doc, T(`${data.companyName}  ·  ${data.title}`), left, fy, contentW * 0.7, { font: 'Helvetica', size: 7, color: MUTED });
    singleLine(doc, `Page ${i - range.start + 1} of ${range.count}`, left + contentW * 0.7, fy, contentW * 0.3, { font: 'Helvetica', size: 7, color: MUTED, align: 'right' });
  }
  doc.flushPages();
  doc.end();
  return done;
}
