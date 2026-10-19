import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePeriod, listAudit, reopenPeriod, updateCompany, ServiceError } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.destroy());

const version = () => w.run(w.ctxA, async (s) => s.company.version);

describe('fiscal year start month', () => {
  it('changes while no period is closed and records the change in the audit trail', async () => {
    const saved = await w.run(w.ctxA, async (s) => updateCompany(s, { version: s.company.version, fiscalYearStartMonth: 7 }));
    expect(saved.fiscalYearStartMonth).toBe(7);
    const audit = await w.run(w.ctxA, (s) => listAudit(s, { limit: 5, entityType: 'company' }));
    const ev = audit.items.find((e) => e.action === 'company.updated');
    expect(ev?.details).toMatchObject({ fiscalYearStartMonth: { from: 1, to: 7 } });
  });

  it('is rejected with a clear error once a period is closed, and allowed again after reopening', async () => {
    const period = await w.run(w.ctxA, (s) => closePeriod(s, { startDate: '2026-01-01', endDate: '2026-01-31' }));
    const err = await w.run(w.ctxA, async (s) => updateCompany(s, { version: s.company.version, fiscalYearStartMonth: 10 })).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe('invalid_state');
    expect((err as ServiceError).message).toMatch(/no accounting periods are closed.*Reopen the 1 closed period/);
    expect(await w.run(w.ctxA, async (s) => s.company.fiscalYearStartMonth)).toBe(7);

    // Unrelated edits, and re-sending the unchanged month, still work while periods are closed.
    const renamed = await w.run(w.ctxA, async (s) => updateCompany(s, { version: s.company.version, name: 'Alpha Renamed', fiscalYearStartMonth: 7 }));
    expect(renamed.name).toBe('Alpha Renamed');

    await w.run(w.ctxA, (s) => reopenPeriod(s, period.id, { version: period.version, reason: 'Fiscal year change' }));
    const changed = await w.run(w.ctxA, async (s) => updateCompany(s, { version: await version(), fiscalYearStartMonth: 10 }));
    expect(changed.fiscalYearStartMonth).toBe(10);
  });

  it("does not see another company's closed periods", async () => {
    await w.run(w.ctxB, (s) => closePeriod(s, { startDate: '2026-02-01', endDate: '2026-02-28' }));
    const saved = await w.run(w.ctxA, async (s) => updateCompany(s, { version: s.company.version, fiscalYearStartMonth: 4 }));
    expect(saved.fiscalYearStartMonth).toBe(4);
  });
});
