import { Money } from '@evenbooks/domain';

/** Convert a PostgreSQL numeric string (scale 6) to Money at the currency precision. */
export function fromDb(value: string | null | undefined, currency: string): Money {
  return Money.round(value ?? '0', currency);
}

/** Serialize Money for a numeric column. */
export function toDb(m: Money): string {
  return m.toString();
}
