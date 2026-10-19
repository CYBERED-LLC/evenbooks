/**
 * Currency metadata. MVP supports USD only, but nothing outside this file may
 * assume two decimal places: always consult the currency's `minorUnits`.
 */
export interface Currency {
  readonly code: string;
  readonly minorUnits: number;
  readonly symbol: string;
}

const REGISTRY: Record<string, Currency> = {
  USD: { code: 'USD', minorUnits: 2, symbol: '$' },
};

export class UnsupportedCurrencyError extends Error {
  constructor(public readonly code: string) {
    super(`Unsupported currency: ${code}`);
    this.name = 'UnsupportedCurrencyError';
  }
}

export function getCurrency(code: string): Currency {
  const c = REGISTRY[code];
  if (!c) throw new UnsupportedCurrencyError(code);
  return c;
}

export function isSupportedCurrency(code: string): boolean {
  return code in REGISTRY;
}

export const SUPPORTED_CURRENCIES: readonly string[] = Object.keys(REGISTRY);
