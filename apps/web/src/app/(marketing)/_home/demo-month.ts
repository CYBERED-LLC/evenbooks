/**
 * The month the homepage demos are set in: always the current one, so the
 * story reads as happening now. The server picks it (in US Eastern time) and
 * passes it down, so server and browser never disagree around midnight on
 * the 1st.
 */
export interface DemoMonth {
  year: number;
  /** 1–12. */
  month: number;
  /** "September". */
  name: string;
  /** "Sep". */
  short: string;
  /** 28–31. */
  days: number;
}

const DEMO_TIME_ZONE = 'America/New_York';

export function currentDemoMonth(now: Date = new Date()): DemoMonth {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: DEMO_TIME_ZONE, year: 'numeric', month: 'numeric' }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')!.value);
  const month = Number(parts.find((p) => p.type === 'month')!.value);
  return demoMonth(year, month);
}

export function demoMonth(year: number, month: number): DemoMonth {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const name = first.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const short = first.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return { year, month, name, short, days };
}

/**
 * The story is written against a 30-day month. Map its day onto this month so
 * the first day stays the 1st and the last lands on the month's final day.
 */
export function storyDay(m: DemoMonth, day: number): number {
  return 1 + Math.round(((day - 1) * (m.days - 1)) / 29);
}

/** "Sep 18" for a story day, or for a day `offset` days after it (which may fall in the next month). */
export function dayLabel(m: DemoMonth, day: number, offset = 0): string {
  const d = new Date(Date.UTC(m.year, m.month - 1, storyDay(m, day) + offset));
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
