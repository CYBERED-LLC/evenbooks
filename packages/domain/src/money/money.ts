import Decimal from 'decimal.js';
import { getCurrency } from './currency';

/**
 * Rounding policy (documented in docs/financial-policy.md):
 * monetary amounts are rounded HALF_UP (half away from zero) to the currency's
 * minor units. Quantities and unit prices keep up to 6 decimal places.
 */
export const MONEY_ROUNDING = Decimal.ROUND_HALF_UP;
export const PRECISE_SCALE = 6;

// Use an isolated Decimal constructor so callers elsewhere cannot change our config.
export const D = Decimal.clone({ precision: 40, rounding: MONEY_ROUNDING });
export type Dec = InstanceType<typeof D>;

export type DecimalLike = string | number | Dec | Decimal;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export class CurrencyMismatchError extends MoneyError {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = 'CurrencyMismatchError';
  }
}

function toDec(v: DecimalLike): Dec {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new MoneyError('Non-finite number');
    // Numbers are accepted only for small integer literals in tests/fixtures.
    if (!Number.isInteger(v)) {
      throw new MoneyError('Floating-point numbers are not accepted for money; pass a decimal string');
    }
  }
  const d = new D(v as never);
  if (!d.isFinite()) throw new MoneyError('Non-finite decimal');
  return d;
}

/**
 * Immutable monetary value at exactly the currency's minor-unit scale.
 */
export class Money {
  private constructor(
    private readonly value: Dec,
    public readonly currency: string,
  ) {}

  /** Construct from an amount already at (or below) the currency precision. Throws if more precise. */
  static of(amount: DecimalLike, currency: string): Money {
    const cur = getCurrency(currency);
    const d = toDec(amount);
    if (d.decimalPlaces() > cur.minorUnits) {
      throw new MoneyError(
        `Amount ${d.toString()} has more precision than ${currency} allows (${cur.minorUnits}); round explicitly`,
      );
    }
    return new Money(d.toDecimalPlaces(cur.minorUnits, MONEY_ROUNDING), currency);
  }

  /** Round an arbitrary-precision decimal to currency precision using the documented policy. */
  static round(amount: DecimalLike, currency: string): Money {
    const cur = getCurrency(currency);
    return new Money(toDec(amount).toDecimalPlaces(cur.minorUnits, MONEY_ROUNDING), currency);
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  static sum(items: readonly Money[], currency?: string): Money {
    if (items.length === 0) {
      if (!currency) throw new MoneyError('Cannot sum an empty list without a currency');
      return Money.zero(currency);
    }
    return items.reduce((acc, m) => acc.add(m), Money.zero(items[0]!.currency));
  }

  get decimal(): Dec {
    return this.value;
  }

  private assertSame(other: Money): void {
    if (other.currency !== this.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }

  add(other: Money): Money {
    this.assertSame(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSame(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.value.abs(), this.currency);
  }

  /** Multiply by a factor and round to currency precision. */
  multiply(factor: DecimalLike): Money {
    return Money.round(this.value.times(toDec(factor)), this.currency);
  }

  /** Exact product (unrounded) for intermediate calculations. */
  multiplyExact(factor: DecimalLike): Dec {
    return this.value.times(toDec(factor));
  }

  min(other: Money): Money {
    this.assertSame(other);
    return this.value.lte(other.value) ? this : other;
  }

  max(other: Money): Money {
    this.assertSame(other);
    return this.value.gte(other.value) ? this : other;
  }

  isZero(): boolean {
    return this.value.isZero();
  }
  isPositive(): boolean {
    return this.value.gt(0);
  }
  isNegative(): boolean {
    return this.value.lt(0);
  }
  compare(other: Money): -1 | 0 | 1 {
    this.assertSame(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }
  gt(other: Money): boolean {
    return this.compare(other) > 0;
  }
  gte(other: Money): boolean {
    return this.compare(other) >= 0;
  }
  lt(other: Money): boolean {
    return this.compare(other) < 0;
  }
  lte(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  /**
   * Split this amount across weights using the largest-remainder method.
   * The returned parts sum exactly to this amount. Zero-weight parts get zero.
   * Deterministic: ties broken by earliest index.
   */
  allocate(weights: readonly DecimalLike[]): Money[] {
    const cur = getCurrency(this.currency);
    const ws = weights.map(toDec);
    if (ws.some((w) => w.isNegative())) throw new MoneyError('Allocation weights must be non-negative');
    const totalWeight = ws.reduce((a, b) => a.plus(b), new D(0));
    if (ws.length === 0) return [];
    if (totalWeight.isZero()) {
      // Nothing to weight by: give everything to the first part so the sum invariant holds.
      return ws.map((_, i) => (i === 0 ? this : Money.zero(this.currency)));
    }
    const unit = new D(10).pow(-cur.minorUnits);
    const totalUnits = this.value.div(unit); // integer number of minor units
    const exact = ws.map((w) => totalUnits.times(w).div(totalWeight));
    const floors = exact.map((e) => e.toDecimalPlaces(0, Decimal.ROUND_DOWN));
    let remainder = totalUnits.minus(floors.reduce((a, b) => a.plus(b), new D(0)));
    const order = exact
      .map((e, i) => ({ i, frac: e.minus(floors[i]!) }))
      .sort((a, b) => {
        const c = b.frac.abs().comparedTo(a.frac.abs());
        return c !== 0 ? c : a.i - b.i;
      });
    const step = remainder.isNegative() ? -1 : 1;
    const result = floors.slice();
    let idx = 0;
    while (!remainder.isZero()) {
      const target = order[idx % order.length]!.i;
      result[target] = result[target]!.plus(step);
      remainder = remainder.minus(step);
      idx++;
    }
    return result.map((units) => new Money(units.times(unit), this.currency));
  }

  /** Fixed-point string at currency scale, e.g. "1234.50". */
  toString(): string {
    return this.value.toFixed(getCurrency(this.currency).minorUnits);
  }

  toJSON(): string {
    return this.toString();
  }

  /** Amount in minor units as a bigint (e.g. cents). */
  toMinorUnits(): bigint {
    const cur = getCurrency(this.currency);
    return BigInt(this.value.times(new D(10).pow(cur.minorUnits)).toFixed(0));
  }
}

/** Parse a precise (quantity / unit price) decimal string, limiting scale to PRECISE_SCALE. */
export function parsePrecise(v: DecimalLike): Dec {
  const d = toDec(v);
  if (d.decimalPlaces() > PRECISE_SCALE) {
    throw new MoneyError(`Value ${d.toString()} exceeds ${PRECISE_SCALE} decimal places`);
  }
  return d;
}

export function decimalString(v: DecimalLike, scale?: number): string {
  const d = toDec(v);
  return scale === undefined ? d.toString() : d.toFixed(scale);
}

export { Decimal };
