import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import * as schema from '../src/schema/index';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(async () => {
  await tdb.destroy();
});

describe('migrations', () => {
  it('apply cleanly and are idempotent', async () => {
    const { rows } = await tdb.owner.pool.query('select name from schema_migrations order by name');
    expect(rows.length).toBeGreaterThanOrEqual(7);
    const { migrate } = await import('../src/migrate.js');
    const again = await migrate(tdb.owner.pool);
    expect(again.applied).toEqual([]);
  });

  it('drizzle schema mirrors the database (no drift)', async () => {
    const { rows } = await tdb.owner.pool.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public'`,
    );
    const dbCols = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      if (!dbCols.has(r.table_name)) dbCols.set(r.table_name, new Map());
      dbCols.get(r.table_name)!.set(r.column_name, r.is_nullable === 'YES');
    }
    const problems: string[] = [];
    for (const value of Object.values(schema)) {
      if (typeof value !== 'object' || value === null || !('_' in (value as object))) continue;
      let tableName: string;
      try {
        tableName = getTableName(value as never);
      } catch {
        continue;
      }
      const cols = getTableColumns(value as never);
      const actual = dbCols.get(tableName);
      if (!actual) {
        problems.push(`table ${tableName} missing in database`);
        continue;
      }
      for (const [, col] of Object.entries(cols)) {
        const c = col as { name: string; notNull: boolean };
        if (!actual.has(c.name)) {
          problems.push(`${tableName}.${c.name} missing in database`);
        } else if (actual.get(c.name) === c.notNull) {
          problems.push(`${tableName}.${c.name} nullability mismatch (db nullable=${actual.get(c.name)})`);
        }
      }
      const modeled = new Set(Object.values(cols).map((c) => (c as { name: string }).name));
      for (const name of actual.keys()) {
        if (!modeled.has(name)) problems.push(`${tableName}.${name} not modeled in drizzle schema`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every company-scoped table has RLS forced', async () => {
    const { rows } = await tdb.owner.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and exists (select 1 from information_schema.columns col
                       where col.table_schema = 'public' and col.table_name = c.relname and col.column_name = 'company_id')`,
    );
    const missing = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity).map((r) => r.relname);
    expect(rows.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('application role cannot bypass RLS or run DDL', async () => {
    const { rows } = await tdb.app.pool.query(`select rolbypassrls, rolsuper from pg_roles where rolname = current_user`);
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    await expect(tdb.app.pool.query('create table should_fail (id int)')).rejects.toThrow(/permission denied/);
  });
});
