/**
 * Plain calendar-date helpers operating on ISO `YYYY-MM-DD` strings.
 * Accounting dates are calendar dates without time or zone; they are only
 * converted to instants at the edges (scheduling, "today" defaults).
 */
export type PlainDate = string; // YYYY-MM-DD

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Invalid date: ${value}`);
    this.name = 'InvalidDateError';
  }
}

export function isPlainDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function assertPlainDate(value: string): PlainDate {
  if (!isPlainDate(value)) throw new InvalidDateError(value);
  return value;
}

export function parts(date: PlainDate): { year: number; month: number; day: number } {
  const m = ISO_DATE.exec(date);
  if (!m) throw new InvalidDateError(date);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function fromParts(year: number, month: number, day: number): PlainDate {
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

export function toEpochDays(date: PlainDate): number {
  const { year, month, day } = parts(date);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function fromEpochDays(days: number): PlainDate {
  const d = new Date(days * 86_400_000);
  return fromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function addDays(date: PlainDate, n: number): PlainDate {
  return fromEpochDays(toEpochDays(date) + n);
}

/** Add months, clamping the day to the last day of the target month. */
export function addMonthsClamped(date: PlainDate, n: number): PlainDate {
  const { year, month, day } = parts(date);
  const total = year * 12 + (month - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return fromParts(y, m, Math.min(day, daysInMonth(y, m)));
}

export function compareDates(a: PlainDate, b: PlainDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function endOfMonth(date: PlainDate): PlainDate {
  const { year, month } = parts(date);
  return fromParts(year, month, daysInMonth(year, month));
}

export function startOfMonth(date: PlainDate): PlainDate {
  const { year, month } = parts(date);
  return fromParts(year, month, 1);
}

export function yearOf(date: PlainDate): number {
  return parts(date).year;
}

/** Today's calendar date in an IANA time zone. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): PlainDate {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const partsArr = fmt.formatToParts(now);
  const get = (t: string) => partsArr.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (minutes east of UTC) of `timeZone` at the given instant. */
function offsetMinutes(timeZone: string, at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = fmt.formatToParts(at);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? '0');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * The UTC instant of local wall-clock time `hour:minute` on `date` in `timeZone`.
 * Converges through two offset passes so DST transitions resolve sensibly.
 */
export function zonedInstant(date: PlainDate, timeZone: string, hour = 0, minute = 0): Date {
  const { year, month, day } = parts(date);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = naive - offsetMinutes(timeZone, new Date(naive)) * 60_000;
  guess = naive - offsetMinutes(timeZone, new Date(guess)) * 60_000;
  return new Date(guess);
}
