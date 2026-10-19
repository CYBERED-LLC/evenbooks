import { describe, expect, it } from 'vitest';
import { formatDecimalInput, parseDecimalInput, sumDecimals } from './decimal';

describe('parseDecimalInput', () => {
  it.each([
    ['1,200.50', '1200.50'],
    ['$45', '45'],
    [' $ 1,000 ', '1000'],
    ['.5', '0.5'],
    ['12.', '12'],
    ['(45.10)', '-45.10'],
    ['-$3.20', '-3.20'],
    ['+7', '7'],
    ['007.25', '7.25'],
    ['0', '0'],
    ['-0', '0'],
    ['€12', '12'],
    ['', ''],
  ])('%s → %s', (raw, want) => expect(parseDecimalInput(raw)).toBe(want));

  it.each(['abc', '1.2.3', '12-', '--4', '1e5', '$'])('rejects %s', (raw) => expect(parseDecimalInput(raw)).toBeNull());

  it('rejects negatives when not allowed', () => {
    expect(parseDecimalInput('-5', { allowNegative: false })).toBeNull();
    expect(parseDecimalInput('5', { allowNegative: false })).toBe('5');
  });

  it('feeds sums once parsed', () => {
    expect(sumDecimals([parseDecimalInput('1,200')!, parseDecimalInput('$0.50')!])).toBe('1200.50');
  });
});

describe('formatDecimalInput', () => {
  it.each([
    ['1200', '1,200.00'],
    ['1234567.891', '1,234,567.891'],
    ['-45.1', '-45.10'],
    ['0.5', '0.50'],
  ])('%s → %s', (v, want) => expect(formatDecimalInput(v)).toBe(want));
});
