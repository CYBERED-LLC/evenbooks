import { describe, expect, it } from 'vitest';
import { DecimalString, MAX_DECIMAL_LENGTH, NonNegativeDecimalString, PositiveDecimalString } from '../src/common';

describe('decimal strings', () => {
  it('accept ordinary amounts', () => {
    expect(DecimalString.parse('-0.25')).toBe('-0.25');
    expect(NonNegativeDecimalString.parse('1234.567890')).toBe('1234.567890');
    expect(PositiveDecimalString.parse('0.01')).toBe('0.01');
    expect(DecimalString.parse('99999999999999.999999')).toBe('99999999999999.999999');
  });

  it('reject anything longer than the database can store', () => {
    const tooLong = '1'.repeat(MAX_DECIMAL_LENGTH + 1);
    expect(DecimalString.safeParse(tooLong).success).toBe(false);
    expect(NonNegativeDecimalString.safeParse(tooLong).success).toBe(false);
    expect(PositiveDecimalString.safeParse(tooLong).success).toBe(false);
    expect(DecimalString.safeParse('1'.repeat(1_000_000)).success).toBe(false);
  });
});
