import { describe, expect, it } from 'vitest';
import { Money, MoneyError, CurrencyMismatchError, UnsupportedCurrencyError, parsePrecise } from '../src/index';

describe('Money', () => {
  it('constructs from decimal strings at currency precision', () => {
    expect(Money.of('12.30', 'USD').toString()).toBe('12.30');
    expect(Money.of('12.3', 'USD').toString()).toBe('12.30');
    expect(Money.of(5, 'USD').toString()).toBe('5.00');
  });

  it('rejects excess precision unless rounding is explicit', () => {
    expect(() => Money.of('1.005', 'USD')).toThrow(MoneyError);
    expect(Money.round('1.005', 'USD').toString()).toBe('1.01'); // HALF_UP
    expect(Money.round('1.004', 'USD').toString()).toBe('1.00');
    expect(Money.round('-1.005', 'USD').toString()).toBe('-1.01'); // half away from zero
  });

  it('rejects floating point numbers and unsupported currencies', () => {
    expect(() => Money.of(0.1, 'USD')).toThrow(MoneyError);
    expect(() => Money.of('1', 'EUR')).toThrow(UnsupportedCurrencyError);
  });

  it('adds and subtracts exactly', () => {
    const a = Money.of('0.10', 'USD');
    const b = Money.of('0.20', 'USD');
    expect(a.add(b).toString()).toBe('0.30');
    expect(a.subtract(b).toString()).toBe('-0.10');
    expect(() => a.add(Money.of('1', 'USD') as never)).not.toThrow();
  });

  it('refuses mixed currencies', () => {
    const a = Money.of('1', 'USD');
    const fake = Object.create(Money.prototype, {
      value: { value: a.decimal },
      currency: { value: 'XXX' },
    }) as Money;
    expect(() => a.add(fake)).toThrow(CurrencyMismatchError);
  });

  it('allocates by largest remainder with exact sum', () => {
    const parts = Money.of('100.00', 'USD').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts).toString()).toBe('100.00');

    const uneven = Money.of('0.05', 'USD').allocate(['3', '7']);
    expect(uneven.map(String)).toEqual(['0.02', '0.03']);

    const neg = Money.of('-10.00', 'USD').allocate([1, 2]);
    expect(Money.sum(neg).toString()).toBe('-10.00');
    expect(neg.map(String)).toEqual(['-3.33', '-6.67']);
  });

  it('allocate handles zero weights and zero totals', () => {
    expect(Money.of('10', 'USD').allocate([0, 0]).map(String)).toEqual(['10.00', '0.00']);
    expect(Money.of('0', 'USD').allocate([5, 5]).map(String)).toEqual(['0.00', '0.00']);
    expect(Money.of('10', 'USD').allocate([0, 5]).map(String)).toEqual(['0.00', '10.00']);
  });

  it('multiplies with rounding', () => {
    expect(Money.of('19.99', 'USD').multiply('0.0825').toString()).toBe('1.65'); // 1.649175
    expect(Money.of('100', 'USD').multiplyExact('0.0825').toString()).toBe('8.25');
  });

  it('serializes as string and minor units', () => {
    expect(JSON.stringify({ a: Money.of('1.5', 'USD') })).toBe('{"a":"1.50"}');
    expect(Money.of('12.34', 'USD').toMinorUnits()).toBe(1234n);
  });

  it('parsePrecise limits scale to 6', () => {
    expect(parsePrecise('1.123456').toString()).toBe('1.123456');
    expect(() => parsePrecise('1.1234567')).toThrow(MoneyError);
  });
});
