import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@evenbooks/db/testing';
import { resolveCompanyForOrg, resolveCompanyForOrgDetailed } from '../src/index';

/**
 * The first requests for a brand-new organization arrive together (layout,
 * page and API calls each resolve the company). Provisioning must be
 * idempotent under that race: every caller gets the same company and the
 * chart of accounts is created exactly once.
 */
describe('resolveCompanyForOrg', () => {
  let tdb: TestDatabase;
  beforeAll(async () => {
    tdb = await createTestDatabase();
  });
  afterAll(() => tdb.destroy());

  it('returns one company when provisioned concurrently', async () => {
    const input = { clerkOrgId: 'org_race', name: 'Race Co', actorId: 'user_race' };
    const results = await Promise.all(Array.from({ length: 6 }, () => resolveCompanyForOrg(tdb.app.db, input)));
    const ids = new Set(results.map((c) => c.id));
    expect(ids.size).toBe(1);
    expect(results.every((c) => c.name === 'Race Co')).toBe(true);

    const res = (await tdb.admin.db.execute(
      sql`select (select count(*)::int from companies where clerk_org_id = 'org_race') as companies,
                 (select count(*)::int from accounts where company_id = ${[...ids][0]}) as accounts`,
    )) as unknown as { rows?: unknown[] } | unknown[];
    const { companies, accounts } = (Array.isArray(res) ? res[0] : res.rows?.[0]) as { companies: number; accounts: number };
    expect(companies).toBe(1);
    expect(accounts).toBeGreaterThan(0);
  });

  it('is a no-op for an existing organization', async () => {
    const first = await resolveCompanyForOrg(tdb.app.db, { clerkOrgId: 'org_once', name: 'Once', actorId: 'u' });
    const second = await resolveCompanyForOrg(tdb.app.db, { clerkOrgId: 'org_once', name: 'Renamed', actorId: 'u' });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Once');
  });
});

describe('plan sync from the identity provider', () => {
  it('reports creation and plan changes so callers can push membership limits', async () => {
    const { createTestDatabase } = await import('@evenbooks/db/testing');
    const tdb = await createTestDatabase('evenbooks_plan');
    try {
      const first = await resolveCompanyForOrgDetailed(tdb.app.db, { clerkOrgId: 'org_plan', name: 'Plan Co', actorId: 'u', plan: 'free' });
      expect(first.created).toBe(true);
      expect(first.planChanged).toBe(false); // default is already free
      expect(first.company.plan).toBe('free');
      const same = await resolveCompanyForOrgDetailed(tdb.app.db, { clerkOrgId: 'org_plan', name: 'Plan Co', actorId: 'u', plan: 'free' });
      expect(same.created).toBe(false);
      expect(same.planChanged).toBe(false);
      const upgraded = await resolveCompanyForOrgDetailed(tdb.app.db, { clerkOrgId: 'org_plan', name: 'Plan Co', actorId: 'u', plan: 'paid' });
      expect(upgraded.planChanged).toBe(true);
      expect(upgraded.company.plan).toBe('paid');
      const unknown = await resolveCompanyForOrgDetailed(tdb.app.db, { clerkOrgId: 'org_plan', name: 'Plan Co', actorId: 'u', plan: null });
      expect(unknown.planChanged).toBe(false);
      expect(unknown.company.plan).toBe('paid'); // unknown never downgrades
    } finally {
      await tdb.destroy();
    }
  });
});
