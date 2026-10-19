import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FixtureSimpleFinClient } from '@evenbooks/integrations';
import { createWorld, type TestWorld } from './helpers';
import { connectSimpleFin, getConnection, linkProviderAccounts, syncConnection } from '../src/index';

/**
 * The worker usually polls a brand-new connection before any account is
 * linked. Linking must then allow an immediate sync instead of making the user
 * wait out the 15-minute throttle with empty accounts.
 */
describe('sync throttle after linking', () => {
  let w: TestWorld;
  const saved = process.env.EVENBOOKS_SYNC_NO_THROTTLE;
  beforeAll(async () => {
    delete process.env.EVENBOOKS_SYNC_NO_THROTTLE;
    w = await createWorld();
  });
  afterAll(async () => {
    if (saved !== undefined) process.env.EVENBOOKS_SYNC_NO_THROTTLE = saved;
    await w.destroy();
  });

  it('lets newly linked accounts sync at once, then throttles repeat syncs', async () => {
    const fixture = new FixtureSimpleFinClient(new Date('2026-09-10T12:00:00Z'));
    const acct = await w.accountsByCode(w.ctxA);
    const conn = await w.run(w.ctxA, (s) => connectSimpleFin(s, fixture, { name: 'Demo Bank', setupToken: 'demo-throttle', syncIntervalMinutes: 1440 }));
    const t0 = new Date('2026-09-10T12:00:00Z');

    // Worker tick before anything is linked: succeeds but imports nothing.
    const first = await syncConnection(w.tdb.app.db, fixture, w.companyA, conn.id, 'tick', t0);
    expect(first.ok).toBe(true);
    expect(first.inserted).toBe(0);

    // The sync bumped the row version; a client would have refetched by now.
    const fresh = await w.run(w.ctxA, (s) => getConnection(s, conn.id));
    const linked = await w.run(w.ctxA, (s) =>
      linkProviderAccounts(s, conn.id, {
        version: fresh.version,
        links: [{ providerAccountId: 'demo-checking', create: { name: 'Demo Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! } }],
      }),
    );
    expect(linked.nextSyncAt).not.toBeNull();

    // "Sync now" one minute later must not be throttled and must import.
    const callsBefore = fixture.calls.length;
    const second = await syncConnection(w.tdb.app.db, fixture, w.companyA, conn.id, 'manual', new Date(t0.getTime() + 60_000));
    expect(second.warnings).toEqual([]);
    expect(second.inserted).toBeGreaterThan(0);
    // ...and it fetches the full initial history, not just the 5-day overlap since the first success.
    expect(second.windowStart).toBe('2026-07-12');
    expect(fixture.calls.slice(callsBefore).map((c) => c.startDate!.toISOString().slice(0, 10)).sort()[0]).toBe('2026-07-12');

    // A further manual sync inside the window is throttled as before.
    const third = await syncConnection(w.tdb.app.db, fixture, w.companyA, conn.id, 'manual', new Date(t0.getTime() + 120_000));
    expect(third.warnings[0]).toMatch(/Throttled/);
  });
});
