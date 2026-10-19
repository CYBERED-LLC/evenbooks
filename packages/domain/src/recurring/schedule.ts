import { addDays, addMonthsClamped, compareDates, assertPlainDate, type PlainDate } from '../dates/plain-date';

export const FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannually', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface ScheduleRule {
  frequency: Frequency;
  /** First occurrence date. For monthly-type rules the day-of-month is preserved as the anchor. */
  anchorDate: PlainDate;
  /** Inclusive last date on which an occurrence may fall. */
  endDate?: PlainDate | null;
}

export interface Occurrence {
  index: number;
  date: PlainDate;
}

const MONTH_STEP: Partial<Record<Frequency, number>> = {
  monthly: 1,
  quarterly: 3,
  semiannually: 6,
  yearly: 12,
};

/**
 * Date of the n-th occurrence (0 = anchor). Monthly-type schedules anchored on
 * the 29th–31st fall on the last available day of shorter months while later
 * months return to the original anchor day (computed from the anchor, not the
 * previous occurrence, so the day never drifts).
 */
export function occurrenceDate(rule: ScheduleRule, n: number): PlainDate {
  if (n < 0 || !Number.isInteger(n)) throw new RangeError('Occurrence index must be a non-negative integer');
  const anchor = assertPlainDate(rule.anchorDate);
  switch (rule.frequency) {
    case 'weekly':
      return addDays(anchor, 7 * n);
    case 'biweekly':
      return addDays(anchor, 14 * n);
    default:
      return addMonthsClamped(anchor, MONTH_STEP[rule.frequency]! * n);
  }
}

function withinEnd(rule: ScheduleRule, date: PlainDate): boolean {
  return !rule.endDate || compareDates(date, rule.endDate) <= 0;
}

/** All occurrences with `from <= date <= to` (inclusive), honoring the end date. */
export function occurrencesBetween(rule: ScheduleRule, from: PlainDate, to: PlainDate, maxCount = 1000): Occurrence[] {
  const out: Occurrence[] = [];
  let n = firstIndexOnOrAfter(rule, from);
  for (; out.length < maxCount; n++) {
    const date = occurrenceDate(rule, n);
    if (compareDates(date, to) > 0 || !withinEnd(rule, date)) break;
    out.push({ index: n, date });
  }
  return out;
}

/** Smallest index whose date is on or after `date`. */
export function firstIndexOnOrAfter(rule: ScheduleRule, date: PlainDate): number {
  if (compareDates(occurrenceDate(rule, 0), date) >= 0) return 0;
  let hi = 1;
  while (compareDates(occurrenceDate(rule, hi), date) < 0) hi *= 2;
  let lo = Math.floor(hi / 2);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (compareDates(occurrenceDate(rule, mid), date) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Occurrences that are due (date <= today) and not yet issued, starting after
 * `lastIssuedIndex` (or from the anchor when null). This is the catch-up set
 * used both for normal issuance and for the resume preview.
 */
export function dueOccurrences(
  rule: ScheduleRule,
  lastIssuedIndex: number | null,
  today: PlainDate,
  maxCount = 1000,
): Occurrence[] {
  const out: Occurrence[] = [];
  let n = lastIssuedIndex === null ? 0 : lastIssuedIndex + 1;
  for (; out.length < maxCount; n++) {
    const date = occurrenceDate(rule, n);
    if (compareDates(date, today) > 0 || !withinEnd(rule, date)) break;
    out.push({ index: n, date });
  }
  return out;
}

export function nextOccurrenceAfter(rule: ScheduleRule, lastIssuedIndex: number | null): Occurrence | null {
  const n = lastIssuedIndex === null ? 0 : lastIssuedIndex + 1;
  const date = occurrenceDate(rule, n);
  return withinEnd(rule, date) ? { index: n, date } : null;
}

/** Due date from an issue date and net terms in days. */
export function dueDateFor(issueDate: PlainDate, netDays: number): PlainDate {
  return addDays(issueDate, Math.max(0, netDays));
}
