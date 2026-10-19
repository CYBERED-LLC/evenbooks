import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { migrate } from '../src/migrate';

let tdb: TestDatabase;
beforeAll(async () => { tdb = await createTestDatabase('evenbooks_upgrade'); });
afterAll(async () => { await tdb.destroy(); });

it('upgrades legacy payment origins across companies and restores runtime grants without bypassing RLS', async () => {
  // Reconstruct the pre-rename constraints in this disposable database.
  await tdb.admin.pool.query(`
    delete from schema_migrations where name = '0019_evenbooks.sql';
    alter table processor_charges drop constraint processor_charges_origin_check;
    alter table processor_charges add constraint processor_charges_origin_check check (origin in ('beans', 'external'));
    alter table processor_refunds drop constraint processor_refunds_origin_check;
    alter table processor_refunds add constraint processor_refunds_origin_check check (origin in ('beans', 'external'));
    revoke select, insert, update, delete on all tables in schema public from evenbooks_app;
  `);
  const companies: string[] = [];
  for (let i = 0; i < 2; i++) {
    const company = (await tdb.admin.pool.query<{ id: string }>(
      'insert into companies (clerk_org_id, name) values ($1, $2) returning id',
      [`org_upgrade_${i}`, `Upgrade ${i}`],
    )).rows[0]!.id;
    companies.push(company);
    const clearing = (await tdb.admin.pool.query<{ id: string }>(
      `insert into accounts (company_id, code, name, type, currency)
       values ($1, '1000', 'Clearing', 'asset', 'USD') returning id`, [company],
    )).rows[0]!.id;
    const fees = (await tdb.admin.pool.query<{ id: string }>(
      `insert into accounts (company_id, code, name, type, role, currency, description)
       values ($1, '5000', 'Fees', 'expense', 'processor_fees', 'USD', $2) returning id`,
      [company, 'Card and bank-debit processing fees (Stripe) and Beans platform fees on online payments.'],
    )).rows[0]!.id;
    const connection = (await tdb.admin.pool.query<{ id: string }>(
      `insert into payment_processor_connections
         (company_id, provider, provider_account_id, clearing_account_id, fee_account_id, created_by)
       values ($1, 'stripe', $2, $3, $4, 'user_upgrade') returning id`,
      [company, `acct_upgrade_${i}`, clearing, fees],
    )).rows[0]!.id;
    for (const origin of ['beans', 'external']) {
      const charge = (await tdb.admin.pool.query<{ id: string }>(
        `insert into processor_charges (company_id, connection_id, provider, origin, currency, amount, created_by)
         values ($1, $2, 'stripe', $3, 'USD', 100, 'user_upgrade') returning id`,
        [company, connection, origin],
      )).rows[0]!.id;
      await tdb.admin.pool.query(
        `insert into processor_refunds (company_id, charge_id, provider, kind, origin, amount, requested_by)
         values ($1, $2, 'stripe', 'refund', $3, 10, 'user_upgrade')`, [company, charge, origin],
      );
    }
  }

  const result = await migrate(tdb.owner.pool);
  expect(result.applied).toEqual(['0019_evenbooks.sql']);
  for (const table of ['processor_charges', 'processor_refunds']) {
    const rows = (await tdb.admin.pool.query(`select company_id, origin, amount from ${table} order by company_id, origin`)).rows;
    expect(rows).toHaveLength(4);
    for (const company of companies) {
      expect(rows.filter(r => r.company_id === company).map(r => r.origin)).toEqual(['evenbooks', 'external']);
    }
    expect(rows.map(r => Number(r.amount))).toEqual(Array(4).fill(table === 'processor_charges' ? 100 : 10));
    await expect(tdb.admin.pool.query(`update ${table} set origin = 'beans'`)).rejects.toThrow(/origin_check/);
  }
  const descriptions = (await tdb.admin.pool.query(`select description from accounts where role = 'processor_fees'`)).rows;
  expect(descriptions).toHaveLength(2);
  expect(descriptions.every(r => r.description.includes('Evenbooks platform fees'))).toBe(true);

  // The migration leaves no system or tenant context behind on the owner connection.
  expect((await tdb.owner.pool.query('select * from processor_charges')).rows).toHaveLength(0);
  expect((await tdb.app.pool.query('select * from processor_charges')).rows).toHaveLength(0);
  const app = await tdb.app.pool.connect();
  try {
    await app.query('begin');
    await app.query(`select set_config('app.company_id', $1, true)`, [companies[0]]);
    expect((await app.query('select * from processor_charges')).rows).toHaveLength(2);
  } finally {
    await app.query('rollback');
    app.release();
  }
  expect((await migrate(tdb.owner.pool)).applied).toEqual([]);
});
