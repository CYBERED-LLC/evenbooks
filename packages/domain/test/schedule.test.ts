import { describe, expect, it } from 'vitest';
import {
  occurrenceDate,
  occurrencesBetween,
  dueOccurrences,
  nextOccurrenceAfter,
  firstIndexOnOrAfter,
  todayInTimeZone,
  zonedInstant,
  addMonthsClamped,
} from '../src/index';

describe('recurring schedules', () => {
  it('monthly anchored on the 31st clamps and then restores the anchor', () => {
    const rule = { frequency: 'monthly' as const, anchorDate: '2026-01-31' };
    expect([0, 1, 2, 3, 4].map((n) => occurrenceDate(rule, n))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('handles leap years for Feb 29 anchors yearly', () => {
    const rule = { frequency: 'yearly' as const, anchorDate: '2024-02-29' };
    expect(occurrenceDate(rule, 1)).toBe('2025-02-28');
    expect(occurrenceDate(rule, 4)).toBe('2028-02-29');
  });

  it('weekly and biweekly step by days', () => {
    expect(occurrenceDate({ frequency: 'weekly', anchorDate: '2026-12-28' }, 1)).toBe('2027-01-04');
    expect(occurrenceDate({ frequency: 'biweekly', anchorDate: '2026-01-01' }, 2)).toBe('2026-01-29');
  });

  it('quarterly / semiannual steps', () => {
    expect(occurrenceDate({ frequency: 'quarterly', anchorDate: '2026-11-30' }, 1)).toBe('2027-02-28');
    expect(occurrenceDate({ frequency: 'semiannually', anchorDate: '2026-08-31' }, 1)).toBe('2027-02-28');
  });

  it('lists occurrences between dates and respects the end date', () => {
    const rule = { frequency: 'monthly' as const, anchorDate: '2026-01-15', endDate: '2026-04-01' };
    expect(occurrencesBetween(rule, '2026-02-01', '2026-12-31').map((o) => o.date)).toEqual([
      '2026-02-15',
      '2026-03-15',
    ]);
    expect(firstIndexOnOrAfter(rule, '2026-02-01')).toBe(1);
    expect(firstIndexOnOrAfter(rule, '2020-01-01')).toBe(0);
  });

  it('computes catch-up occurrences after a pause', () => {
    const rule = { frequency: 'monthly' as const, anchorDate: '2026-01-01' };
    const due = dueOccurrences(rule, 1, '2026-06-10');
    expect(due.map((o) => o.index)).toEqual([2, 3, 4, 5]);
    expect(dueOccurrences(rule, null, '2025-12-31')).toEqual([]);
    expect(nextOccurrenceAfter({ ...rule, endDate: '2026-02-15' }, 1)).toBeNull();
    expect(nextOccurrenceAfter(rule, null)).toEqual({ index: 0, date: '2026-01-01' });
  });

  it('addMonthsClamped handles negative and year boundaries', () => {
    expect(addMonthsClamped('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
  });
});

describe('time zones', () => {
  it('derives the company-local date from an instant', () => {
    const now = new Date('2026-03-01T03:30:00Z');
    expect(todayInTimeZone('UTC', now)).toBe('2026-03-01');
    expect(todayInTimeZone('America/Los_Angeles', now)).toBe('2026-02-28');
    expect(todayInTimeZone('Asia/Tokyo', now)).toBe('2026-03-01');
  });

  it('computes local midnight instants across DST', () => {
    expect(zonedInstant('2026-01-15', 'America/New_York').toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(zonedInstant('2026-07-15', 'America/New_York').toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(zonedInstant('2026-07-15', 'America/New_York', 6).toISOString()).toBe('2026-07-15T10:00:00.000Z');
  });
});
