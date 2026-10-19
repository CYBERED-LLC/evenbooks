const currencyFormatters = new Map<string, Intl.NumberFormat>();

function fmt(currency: string): Intl.NumberFormat {
  let f = currencyFormatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
    currencyFormatters.set(currency, f);
  }
  return f;
}

/**
 * Display formatting of a decimal string. Parsing to a JS number here is for
 * presentation only; no arithmetic happens on the result.
 */
export function formatMoney(value: string | number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || value === '') return '';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return String(value);
  return fmt(currency).format(n);
}

export function formatSignedMoney(value: string | null | undefined, currency = 'USD'): string {
  if (!value) return '';
  return formatMoney(value, currency);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

export function isZeroDecimal(v: string | null | undefined): boolean {
  return !v || /^-?0+(\.0+)?$/.test(v);
}

/**
 * Today as YYYY-MM-DD in `timeZone` (pass the company's), or in the browser's own zone.
 * Never the UTC date: after about 8pm Eastern that is already tomorrow.
 */
export function todayIso(timeZone?: string): string {
  const now = new Date();
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch {
      // Unknown zone: fall back to the browser's.
    }
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}
