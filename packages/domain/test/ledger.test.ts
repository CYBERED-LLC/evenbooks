import { describe, expect, it } from 'vitest';
import { Money, normalizeEntryLines, reverseLines, UnbalancedEntryError, InvalidEntryError } from '../src/index';

const usd = (v: string) => Money.of(v, 'USD');

describe('normalizeEntryLines', () => {
  it('accepts a balanced entry', () => {
    const lines = normalizeEntryLines(
      [
        { accountId: 'ar', debit: usd('110') },
        { accountId: 'income', credit: usd('100') },
        { accountId: 'tax', credit: usd('10') },
      ],
      'USD',
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]!.credit.isZero()).toBe(true);
  });

  it('rejects unbalanced entries', () => {
    expect(() =>
      normalizeEntryLines(
        [
          { accountId: 'a', debit: usd('10') },
          { accountId: 'b', credit: usd('9.99') },
        ],
        'USD',
      ),
    ).toThrow(UnbalancedEntryError);
  });

  it('rejects single-line, zero, negative, and two-sided lines', () => {
    expect(() => normalizeEntryLines([{ accountId: 'a', debit: usd('1') }], 'USD')).toThrow(InvalidEntryError);
    expect(() =>
      normalizeEntryLines(
        [
          { accountId: 'a', debit: usd('0') },
          { accountId: 'b', credit: usd('0') },
        ],
        'USD',
      ),
    ).toThrow(InvalidEntryError);
    expect(() =>
      normalizeEntryLines(
        [
          { accountId: 'a', debit: usd('-1') },
          { accountId: 'b', debit: usd('1') },
        ],
        'USD',
      ),
    ).toThrow(InvalidEntryError);
    expect(() =>
      normalizeEntryLines(
        [
          { accountId: 'a', debit: usd('1'), credit: usd('1') },
          { accountId: 'b', debit: usd('1') },
        ],
        'USD',
      ),
    ).toThrow(InvalidEntryError);
  });

  it('reverses lines by swapping sides', () => {
    const lines = normalizeEntryLines(
      [
        { accountId: 'a', debit: usd('5') },
        { accountId: 'b', credit: usd('5') },
      ],
      'USD',
    );
    const rev = reverseLines(lines);
    expect(rev[0]!.credit.toString()).toBe('5.00');
    expect(rev[1]!.debit.toString()).toBe('5.00');
  });
});
