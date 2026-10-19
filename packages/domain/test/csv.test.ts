import { describe, expect, it } from 'vitest';
import { parseCsvAmount, parseCsvDate, normalizeCsvRow, rowFingerprint, CsvRowError } from '../src/index';

describe('parseCsvAmount', () => {
  it('parses common bank formats', () => {
    expect(parseCsvAmount('$1,234.56')).toBe('1234.56');
    expect(parseCsvAmount('(123.45)')).toBe('-123.45');
    expect(parseCsvAmount('-123.45')).toBe('-123.45');
    expect(parseCsvAmount('123.45-')).toBe('-123.45');
    expect(parseCsvAmount('+5')).toBe('5');
    expect(parseCsvAmount('12.50 CR')).toBe('-12.5');
    expect(parseCsvAmount('12.50 DR')).toBe('12.5');
    expect(parseCsvAmount('')).toBeNull();
    expect(parseCsvAmount(null)).toBeNull();
  });
  it('rejects garbage', () => {
    expect(() => parseCsvAmount('abc')).toThrow(CsvRowError);
  });
});

describe('parseCsvDate', () => {
  it('parses ISO, MDY, DMY, two-digit years', () => {
    expect(parseCsvDate('2026-02-03', 'MDY')).toBe('2026-02-03');
    expect(parseCsvDate('2026-02-03T10:00:00Z', 'MDY')).toBe('2026-02-03');
    expect(parseCsvDate('02/03/2026', 'MDY')).toBe('2026-02-03');
    expect(parseCsvDate('02/03/2026', 'DMY')).toBe('2026-03-02');
    expect(parseCsvDate('2/3/26', 'MDY')).toBe('2026-02-03');
    expect(parseCsvDate('2026/02/03', 'DMY')).toBe('2026-02-03');
  });
  it('rejects invalid dates', () => {
    expect(() => parseCsvDate('13/40/2026', 'MDY')).toThrow(CsvRowError);
    expect(() => parseCsvDate('', 'MDY')).toThrow(CsvRowError);
  });
});

describe('normalizeCsvRow', () => {
  const mapping = {
    date: 'Date',
    description: 'Description',
    memo: 'Memo',
    amounts: { debit: 'Debit', credit: 'Credit' },
    dateOrder: 'MDY' as const,
  };
  it('maps debit/credit columns into a signed amount', () => {
    expect(normalizeCsvRow({ Date: '01/05/2026', Description: 'Coffee', Debit: '4.50', Credit: '' }, mapping).amount).toBe(
      '-4.5',
    );
    expect(normalizeCsvRow({ Date: '01/05/2026', Description: 'Deposit', Debit: '', Credit: '100' }, mapping).amount).toBe(
      '100',
    );
  });
  it('supports a single inverted amount column', () => {
    const m = { ...mapping, amounts: { amount: 'Amount', invert: true } };
    expect(normalizeCsvRow({ Date: '01/05/2026', Description: 'x', Amount: '4.50' }, m).amount).toBe('-4.5');
  });
  it('reports row errors by field', () => {
    expect(() => normalizeCsvRow({ Date: '01/05/2026', Description: 'x', Debit: '1', Credit: '1' }, mapping)).toThrow(
      /both a debit and a credit/,
    );
    expect(() => normalizeCsvRow({ Date: '', Description: 'x', Debit: '1' }, mapping)).toThrow(CsvRowError);
  });
});

describe('rowFingerprint', () => {
  it('is stable for equivalent rows and distinct by sequence', () => {
    const a = rowFingerprint('acct', { date: '2026-01-05', amount: '-4.5', description: 'COFFEE  Shop' }, 0);
    const b = rowFingerprint('acct', { date: '2026-01-05', amount: '-4.50', description: 'coffee shop' }, 0);
    const c = rowFingerprint('acct', { date: '2026-01-05', amount: '-4.50', description: 'coffee shop' }, 1);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
