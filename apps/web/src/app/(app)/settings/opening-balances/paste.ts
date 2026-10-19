import { parseDecimalInput } from '../../../../lib/decimal';

export interface PastedBalance {
  /** Account code as pasted (first token of the first column). */
  code: string;
  /** Canonical decimal, possibly negative. */
  amount: string;
  /** 1-based line number in the pasted text. */
  line: number;
}

export interface PasteParseResult {
  rows: PastedBalance[];
  /** Non-blank lines with no parseable amount (headers, notes). */
  skipped: number;
}

/** Split one CSV line, honouring double quotes ("1,234.56" stays one cell). */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Reads balances copied from a spreadsheet (tab-separated) or a CSV file.
 * The first column holds the account code (text after the code, as in
 * "1000 Checking", is ignored); the amount is the last column that reads as a
 * number, so "code, name, balance" and "code, balance" both work.
 */
export function parsePastedBalances(text: string): PasteParseResult {
  const rows: PastedBalance[] = [];
  let skipped = 0;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    if (!raw.trim()) return;
    const cells = (raw.includes('\t') ? raw.split('\t') : splitCsv(raw)).map((c) => c.trim());
    const code = (cells[0] ?? '').split(/\s+/)[0] ?? '';
    let amount: string | null = null;
    for (let i = cells.length - 1; i >= 1; i--) {
      const p = parseDecimalInput(cells[i]!, { allowNegative: true });
      if (p) {
        amount = p;
        break;
      }
    }
    if (!code || amount === null) {
      skipped++;
      return;
    }
    rows.push({ code, amount, line: idx + 1 });
  });
  return { rows, skipped };
}
