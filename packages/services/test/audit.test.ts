import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { listAudit } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;

beforeAll(async () => {
  w = await createWorld();
  // Alpha keeps the default America/New_York time zone. 03:00 UTC on Mar 1 is still Feb 28 there.
  for (const [action, at] of [
    ['test.late_feb', '2026-03-01T03:00:00Z'],
    ['test.mar_first', '2026-03-01T15:00:00Z'],
    ['test.mar_last', '2026-03-31T23:00:00Z'],
    ['test.apr', '2026-04-01T12:00:00Z'],
  ] as const) {
    await w.tdb.admin.db.execute(
      sql`insert into audit_events (company_id, actor_type, actor_id, action, entity_type, created_at)
          values (${w.companyA}, 'user', 'user_a', ${action}, 'test_entity', ${at}::timestamptz)`,
    );
  }
});
afterAll(async () => {
  await w.destroy();
});

const actions = async (q: { from?: string; to?: string }) =>
  (await w.run(w.ctxA, (s) => listAudit(s, { limit: 50, entityType: 'test_entity', ...q }))).items.map((a) => a.action).sort();

describe('audit trail date filters', () => {
  it('filters by calendar day in the company time zone, inclusive at both ends', async () => {
    expect(await actions({ from: '2026-03-01', to: '2026-03-31' })).toEqual(['test.mar_first', 'test.mar_last']);
    expect(await actions({ to: '2026-02-28' })).toEqual(['test.late_feb']);
    expect(await actions({ from: '2026-04-01' })).toEqual(['test.apr']);
    expect(await actions({})).toHaveLength(4);
  });

  it('never returns another company’s events', async () => {
    const other = await w.run(w.ctxB, (s) => listAudit(s, { limit: 50, entityType: 'test_entity', from: '2026-01-01' }));
    expect(other.items).toHaveLength(0);
  });
});
