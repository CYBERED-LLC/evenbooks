import { describe, expect, it } from 'vitest';
import { currentDemoMonth, dayLabel, demoMonth, storyDay } from './demo-month';

/** Every story day used by the homepage demos. */
const STORY_DAYS = [1, 2, 3, 4, 5, 6, 9, 11, 15, 18, 22, 25, 27, 30];

describe('demo month', () => {
  it('picks the month in US Eastern time, not UTC', () => {
    // 11 pm on Sep 30 in New York is already Oct 1 in UTC.
    expect(currentDemoMonth(new Date('2026-10-01T03:00:00Z')).name).toBe('September');
    expect(currentDemoMonth(new Date('2026-10-01T05:00:00Z')).name).toBe('October');
  });

  it('knows each month’s length', () => {
    expect(demoMonth(2027, 2).days).toBe(28);
    expect(demoMonth(2028, 2).days).toBe(29);
    expect(demoMonth(2026, 9).days).toBe(30);
    expect(demoMonth(2026, 10)).toMatchObject({ name: 'October', short: 'Oct', days: 31 });
  });

  it('keeps a 30-day month as written and stretches others end to end without collisions', () => {
    for (const d of STORY_DAYS) expect(storyDay(demoMonth(2026, 9), d)).toBe(d);
    for (const [year, month] of [
      [2027, 2],
      [2028, 2],
      [2026, 10],
    ] as const) {
      const m = demoMonth(year, month);
      const mapped = STORY_DAYS.map((d) => storyDay(m, d));
      expect(mapped[0]).toBe(1);
      expect(mapped.at(-1)).toBe(m.days);
      expect(new Set(mapped).size).toBe(STORY_DAYS.length);
    }
  });

  it('labels days and rolls due dates into the next month', () => {
    const sep = demoMonth(2026, 9);
    expect(dayLabel(sep, 18)).toBe('Sep 18');
    expect(dayLabel(sep, 18, 30)).toBe('Oct 18');
    expect(dayLabel(demoMonth(2026, 12), 18, 30)).toBe('Jan 18');
  });
});
