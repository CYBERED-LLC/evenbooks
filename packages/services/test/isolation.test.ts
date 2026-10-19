import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withCompany, withSystem } from '@evenbooks/db';
import { createManualJournal, listAccounts, listEntries, getEntry } from '../src/index';
import { createWorld, dbErrorMessage, type TestWorld } from './helpers';

let w: TestWorld;
let acctA: Map<string, string>;
let acctB: Map<string, string>;

beforeAll(async () => {
  w = await createWorld();
  acctA = await w.accountsByCode(w.ctxA);
  acctB = await w.accountsByCode(w.ctxB);
  await w.run(w.ctxA, (s) =>
    createManualJournal(s, {
      date: '2026-03-01',
      memo: 'A only',
      cashTreatment: 'exclude',
      post: true,
      lines: [
        { accountId: acctA.get('1000')!, debit: '100' },
        { accountId: acctA.get('3000')!, credit: '100' },
      ],
    }),
  );
});
afterAll(async () => {
  await w.destroy();
});

describe('company isolation', () => {
  it('company B sees none of company A data through services', async () => {
    const entries = await w.run(w.ctxB, (s) => listEntries(s, { limit: 50 }));
    expect(entries.items).toEqual([]);
    const accounts = await w.run(w.ctxB, (s) => listAccounts(s));
    expect(accounts.every((a) => !acctA.has(a.id))).toBe(true);
    const aEntry = (await w.run(w.ctxA, (s) => listEntries(s, { limit: 1 }))).items[0]!;
    await expect(w.run(w.ctxB, (s) => getEntry(s, aEntry.id))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('cannot write rows for another company even with a forged company id', async () => {
    await expect(
      withCompany(w.tdb.app.db, w.ctxB, (tx) =>
        tx.execute(sql`insert into accounts (company_id, code, name, type, currency) values (${w.companyA}, '9999', 'Forged', 'asset', 'USD')`),
      ),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(dbErrorMessage(e)));
  });

  it('cannot link a journal line to another company account (composite FK)', async () => {
    await expect(
      w.run(w.ctxB, (s) =>
        createManualJournal(s, {
          date: '2026-03-02',
          memo: 'cross',
          cashTreatment: 'exclude',
          post: true,
          lines: [
            { accountId: acctA.get('1000')!, debit: '5' },
            { accountId: acctB.get('3000')!, credit: '5' },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    // and the database itself refuses the FK even if the service were bypassed
    await expect(
      withCompany(w.tdb.app.db, w.ctxB, async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, date, memo, status, source_type, currency, cash_treatment, created_by)
          values (${w.companyB}, '2026-03-02', 'x', 'draft', 'manual', 'USD', 'exclude', 't') returning id`);
        await tx.execute(sql`insert into journal_lines (company_id, entry_id, line_no, account_id, debit) values (${w.companyB}, ${r.rows[0]!.id}, 1, ${acctA.get('1000')}, 5)`);
      }),
    ).rejects.toSatisfy((e: unknown) => /foreign key|violates/.test(dbErrorMessage(e)));
  });

  it('without a company context the application role sees nothing', async () => {
    const { rows } = await w.tdb.app.pool.query('select count(*)::int as n from accounts');
    expect(rows[0].n).toBe(0);
    const c = await w.tdb.app.pool.query('select count(*)::int as n from companies');
    expect(c.rows[0].n).toBe(0);
  });

  it('company context does not leak across pooled connections', async () => {
    // Run several scoped transactions, then hit the pool without context.
    await Promise.all(
      Array.from({ length: 6 }, () => withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`select count(*) from accounts`))),
    );
    for (let i = 0; i < 6; i++) {
      const { rows } = await w.tdb.app.pool.query('select count(*)::int as n from accounts');
      expect(rows[0].n).toBe(0);
    }
    const { rows } = await w.tdb.app.pool.query(`select current_setting('app.company_id', true) as v`);
    expect(rows[0].v ?? '').toBe('');
  });

  it('the table owner is also subject to RLS (FORCE) while superusers bypass', async () => {
    const owner = await w.tdb.owner.pool.query('select count(*)::int as n from accounts');
    expect(owner.rows[0].n).toBe(0);
    const admin = await w.tdb.admin.pool.query('select count(*)::int as n from accounts');
    expect(admin.rows[0].n).toBeGreaterThan(0);
  });

  it('system context can read companies but cannot write company-scoped rows without a company', async () => {
    const names = await withSystem(w.tdb.app.db, async (tx) => (await tx.execute<{ name: string }>(sql`select name from companies order by name`)).rows);
    expect(names.map((n) => n.name)).toEqual(['Alpha LLC', 'Beta Inc']);
    await expect(
      withSystem(w.tdb.app.db, (tx) =>
        tx.execute(sql`insert into accounts (company_id, code, name, type, currency) values (${w.companyA}, '9998', 'Sys', 'asset', 'USD')`),
      ),
    ).rejects.toSatisfy((e: unknown) => /row-level security/.test(dbErrorMessage(e)));
  });

  it('an invalid company id is rejected before touching the database', async () => {
    await expect(withCompany(w.tdb.app.db, { companyId: 'nope', actorId: 'x', actorType: 'user' }, async () => 1)).rejects.toSatisfy((e: unknown) => /Invalid company id/.test(dbErrorMessage(e)));
  });
});
