import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalEntryDto, ListJournalQuery, Page } from '@evenbooks/contracts';
import { createManualJournal, listEntries } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
const memo = 'sort-probe';

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  // Seven entries over four dates (ties on date), five posted and two drafts (no number).
  const dates = ['2026-03-01', '2026-03-01', '2026-03-02', '2026-03-03', '2026-03-03', '2026-03-03', '2026-03-04'];
  for (const [i, date] of dates.entries()) {
    await w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date,
        memo: `${memo} ${i}`,
        cashTreatment: 'include',
        post: i !== 2 && i !== 5,
        idempotencyKey: `sort-probe-${i}-xxxxxxxx`,
        lines: [
          { accountId: acct.get('5110')!, debit: '1.00' },
          { accountId: acct.get('1000')!, credit: '1.00' },
        ],
      }),
    );
  }
});
afterAll(async () => {
  await w.destroy();
});

async function pageThrough(q: Partial<ListJournalQuery>, limit = 2) {
  const seen: JournalEntryDto[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  for (let i = 0; i < 20; i++) {
    const page: Page<JournalEntryDto> = await w.run(w.ctxA, (s) => listEntries(s, { limit, q: memo, ...q, cursor }));
    seen.push(...page.items);
    total = page.total;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { seen, total };
}

describe('list sorting with keyset paging', () => {
  it('pages by date (default, newest first) without skipping or repeating tied rows', async () => {
    const { seen, total } = await pageThrough({});
    expect(total).toBe(7);
    expect(new Set(seen.map((e) => e.id)).size).toBe(7);
    const dates = seen.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('sorts by entry number both ways, drafts (no number) sorting as 0', async () => {
    const asc = await pageThrough({ sort: 'number', dir: 'asc' }, 3);
    expect(asc.seen).toHaveLength(7);
    const nums = asc.seen.map((e) => e.entryNumber ?? 0);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
    expect(nums.slice(0, 2)).toEqual([0, 0]);

    const desc = await pageThrough({ sort: 'number', dir: 'desc' }, 3);
    expect(desc.seen.map((e) => e.id)).toEqual([...asc.seen].reverse().map((e) => e.id));
  });

  it('ignores a cursor made for another sort and starts over', async () => {
    const first = await w.run(w.ctxA, (s) => listEntries(s, { limit: 2, q: memo }));
    const other = await w.run(w.ctxA, (s) => listEntries(s, { limit: 2, q: memo, sort: 'number', dir: 'asc', cursor: first.nextCursor! }));
    const fresh = await w.run(w.ctxA, (s) => listEntries(s, { limit: 2, q: memo, sort: 'number', dir: 'asc' }));
    expect(other.items.map((e) => e.id)).toEqual(fresh.items.map((e) => e.id));
    // legacy "date|id" cursors from bookmarked URLs also just restart
    const legacy = await w.run(w.ctxA, (s) => listEntries(s, { limit: 2, q: memo, cursor: '2026-03-03|00000000-0000-0000-0000-000000000000' }));
    expect(legacy.items.map((e) => e.id)).toEqual(first.items.map((e) => e.id));
  });
});
