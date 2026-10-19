import { describe, expect, it } from 'vitest';
import { csvCell } from './csv-cell';

describe('csvCell', () => {
  it('passes plain text and numbers through', () => {
    expect(csvCell('Coffee')).toBe('Coffee');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell('1200.00')).toBe('1200.00');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('keeps negative amounts as numbers', () => {
    expect(csvCell('-42.10')).toBe('-42.10');
    expect(csvCell(-3)).toBe('-3');
  });

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises cells a spreadsheet would execute', () => {
    expect(csvCell('=HYPERLINK("https://x.test","Details")')).toBe(`"'=HYPERLINK(""https://x.test"",""Details"")"`);
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-cmd|calc')).toBe("'-cmd|calc");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
  });
});
