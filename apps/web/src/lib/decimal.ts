/**
 * Small client-side decimal helpers for form display totals. These operate on
 * strings with BigInt minor units so totals shown in forms match what the
 * server computes. Not used for authoritative financial results.
 */
const DEC_RE = /^-?\d+(\.\d+)?$/;

/**
 * Forgiving parse of a typed amount into a canonical decimal string:
 * "$1,200.50" → "1200.50", ".5" → "0.5", "12." → "12", "(45)" → "-45".
 * Returns '' for blank input and null when the text is not a number.
 */
export function parseDecimalInput(raw: string, opts: { allowNegative?: boolean } = {}): string | null {
  let s = raw.trim();
  if (!s) return '';
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/[\s,]/g, '').replace(/\p{Sc}/gu, '');
  if (s.startsWith('-')) {
    neg = !neg;
    s = s.slice(1).replace(/\p{Sc}/gu, '');
  } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  if (s.startsWith('.')) s = `0${s}`;
  if (s.endsWith('.')) s = s.slice(0, -1);
  s = s.replace(/^0+(?=\d)/, '');
  if (neg && !/^0(\.0*)?$/.test(s)) {
    if (opts.allowNegative === false) return null;
    return `-${s}`;
  }
  return s;
}

/** Display form of a canonical decimal with thousands separators and at least `minFraction` decimals. */
export function formatDecimalInput(v: string, minFraction = 2): string {
  if (!DEC_RE.test(v.trim())) return v;
  const s = v.trim();
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const f = frac.length >= minFraction ? frac : frac + '0'.repeat(minFraction - frac.length);
  return `${neg ? '-' : ''}${grouped}${f ? '.' + f : ''}`;
}

export function isValidDecimal(v: string): boolean {
  return DEC_RE.test(v.trim());
}

function toUnits(v: string, scale: number): bigint {
  const s = v.trim();
  if (!DEC_RE.test(s)) return 0n;
  const neg = s.startsWith('-');
  const [intPart, fracPart = ''] = (neg ? s.slice(1) : s).split('.');
  const frac = (fracPart + '0'.repeat(scale)).slice(0, scale);
  // round half up on the truncated digit
  const extra = fracPart.length > scale ? Number(fracPart[scale]) : 0;
  let units = BigInt(intPart!) * 10n ** BigInt(scale) + BigInt(frac || '0');
  if (extra >= 5) units += 1n;
  return neg ? -units : units;
}

function fromUnits(u: bigint, scale: number): string {
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const s = abs.toString().padStart(scale + 1, '0');
  const int = s.slice(0, s.length - scale);
  const frac = s.slice(s.length - scale);
  return `${neg ? '-' : ''}${int}${scale ? '.' + frac : ''}`;
}

export function sumDecimals(values: string[], scale = 2): string {
  const total = values.reduce((acc, v) => acc + toUnits(v || '0', scale), 0n);
  return fromUnits(total, scale);
}

export function subtractDecimals(a: string, b: string, scale = 2): string {
  return fromUnits(toUnits(a || '0', scale) - toUnits(b || '0', scale), scale);
}

export function multiplyDecimals(a: string, b: string, scale = 2): string {
  // exact product then round to scale
  const sa = a.trim();
  const sb = b.trim();
  if (!DEC_RE.test(sa) || !DEC_RE.test(sb)) return fromUnits(0n, scale);
  const da = (sa.split('.')[1] ?? '').length;
  const db = (sb.split('.')[1] ?? '').length;
  const ua = BigInt(sa.replace('.', ''));
  const ub = BigInt(sb.replace('.', ''));
  const prod = ua * ub; // scale da+db
  const targetScale = da + db;
  if (targetScale <= scale) return fromUnits(prod * 10n ** BigInt(scale - targetScale), scale);
  const div = 10n ** BigInt(targetScale - scale);
  let q = prod / div;
  const rem = prod % div;
  const absRem = rem < 0n ? -rem : rem;
  if (absRem * 2n >= div) q += prod < 0n ? -1n : 1n;
  return fromUnits(q, scale);
}

export function compareDecimals(a: string, b: string, scale = 6): number {
  const ua = toUnits(a || '0', scale);
  const ub = toUnits(b || '0', scale);
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

export function negateDecimal(a: string): string {
  const s = a.trim();
  if (!s || s === '0' || /^0(\.0+)?$/.test(s)) return s;
  return s.startsWith('-') ? s.slice(1) : `-${s}`;
}
