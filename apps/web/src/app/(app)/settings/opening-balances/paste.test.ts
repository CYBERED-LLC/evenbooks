import { describe, expect, it } from 'vitest';
import { parsePastedBalances } from './paste';

describe('parsePastedBalances', () => {
  it('reads tab-separated spreadsheet rows and skips headers', () => {
    const r = parsePastedBalances('Code\tAccount\tBalance\n1000\tChecking\t$1,234.56\n2000\tCard\t(45.10)\n\n');
    expect(r.rows).toEqual([
      { code: '1000', amount: '1234.56', line: 2 },
      { code: '2000', amount: '-45.10', line: 3 },
    ]);
    expect(r.skipped).toBe(1);
  });

  it('reads CSV with quoted amounts and a code-plus-name first column', () => {
    const r = parsePastedBalances('"1000 Checking","1,500.00"\r\n3000,Owner equity,250\n');
    expect(r.rows).toEqual([
      { code: '1000', amount: '1500.00', line: 1 },
      { code: '3000', amount: '250', line: 2 },
    ]);
  });

  it('takes the last numeric column and ignores rows without an amount', () => {
    const r = parsePastedBalances('1200\t2025\tnote\n1300\tn/a\n');
    expect(r.rows).toEqual([{ code: '1200', amount: '2025', line: 1 }]);
    expect(r.skipped).toBe(1);
  });
});
