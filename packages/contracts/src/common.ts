import { z } from 'zod';

/** Exact decimal serialized as a string, e.g. "1234.50" or "-0.25". */
/**
 * Longest decimal accepted from a client. The database stores numeric(20,6) (14 integer digits), so
 * anything longer is invalid anyway; the cap also keeps decimal.js arithmetic bounded (its cost grows
 * quadratically with digit count, so unbounded input could pin the event loop).
 */
export const MAX_DECIMAL_LENGTH = 32;

export const DecimalString = z
  .string()
  .max(MAX_DECIMAL_LENGTH, 'Number is too long')
  .regex(/^-?\d+(\.\d+)?$/, 'Expected a decimal string like "123.45"')
  .describe('decimal string');

export const NonNegativeDecimalString = z.string().max(MAX_DECIMAL_LENGTH, 'Number is too long').regex(/^\d+(\.\d+)?$/, 'Expected a non-negative decimal string');

export const PositiveDecimalString = NonNegativeDecimalString.refine((v) => Number.parseFloat(v) > 0, 'Must be greater than zero');

/** Calendar date without time zone. */
export const PlainDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const Uuid = z.uuid();

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);

export const IdempotencyKey = z.string().min(8).max(128);

/**
 * Boolean query-string flag. `z.coerce.boolean()` treats any non-empty string,
 * including "false", as true; this accepts true/false/1/0 (and real booleans).
 */
export const QueryBoolean = z.preprocess((v) => (v === 'true' || v === '1' ? true : v === 'false' || v === '0' || v === '' ? false : v), z.boolean());

export const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof Pagination>;

export const SortDirection = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof SortDirection>;

/** `sort` (one of `keys`) and `dir` query params for a sortable list; defaults are the list's own. */
export function sortParams<const K extends readonly [string, ...string[]]>(keys: K) {
  return z.object({ sort: z.enum(keys).optional(), dir: SortDirection.optional() });
}

export const DateRange = z
  .object({
    from: PlainDateString,
    to: PlainDateString,
  })
  .refine((r) => r.from <= r.to, { message: 'from must be on or before to', path: ['to'] });
export type DateRange = z.infer<typeof DateRange>;

export const Basis = z.enum(['accrual', 'cash']);
export type Basis = z.infer<typeof Basis>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** Rows matching the filters across all pages (lists that count). */
  total?: number;
}

/** Standard API error payload. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Address = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(2).optional(),
});
export type Address = z.infer<typeof Address>;

export const Discount = z.object({
  type: z.enum(['percent', 'fixed']),
  value: NonNegativeDecimalString,
});
export type Discount = z.infer<typeof Discount>;
