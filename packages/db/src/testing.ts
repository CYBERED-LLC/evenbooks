import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { bootstrapRoles, bootstrapDatabase } from './bootstrap';
import { connect, type DbHandle } from './client';
import { migrate } from './migrate';

/**
 * Test database lifecycle. Requires a superuser connection in
 * TEST_DATABASE_ADMIN_URL (defaults to a local cluster). Each call creates a
 * fresh database, bootstraps roles, runs all migrations, and returns handles for
 * the app role, the owner role, and the superuser.
 */
export interface TestDatabase {
  name: string;
  appUrl: string;
  ownerUrl: string;
  adminUrl: string;
  app: DbHandle;
  owner: DbHandle;
  admin: DbHandle;
  destroy(): Promise<void>;
}

const OWNER_PW = process.env.EVENBOOKS_OWNER_PASSWORD ?? 'evenbooks_owner';
const APP_PW = process.env.EVENBOOKS_APP_PASSWORD ?? 'evenbooks_app';

export function adminUrl(): string {
  return process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://theo:theo@localhost:5432/postgres';
}

function withDb(url: string, db: string, user?: string, pw?: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  if (user) {
    u.username = user;
    u.password = pw ?? '';
  }
  return u.toString();
}

export async function createTestDatabase(prefix = 'evenbooks_test'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(4).toString('hex')}`;
  const adminPool = new Pool({ connectionString: adminUrl(), max: 2 });
  await bootstrapRoles(adminPool, { database: name, ownerPassword: OWNER_PW, appPassword: APP_PW });
  const adminTarget = new Pool({ connectionString: withDb(adminUrl(), name), max: 2 });
  await bootstrapDatabase(adminTarget);
  const ownerUrlStr = withDb(adminUrl(), name, 'evenbooks_owner', OWNER_PW);
  const appUrlStr = withDb(adminUrl(), name, 'evenbooks_app', APP_PW);
  const owner = connect({ connectionString: ownerUrlStr, applicationName: 'evenbooks-test-owner', max: 4 });
  await migrate(owner.pool);
  const app = connect({ connectionString: appUrlStr, applicationName: 'evenbooks-test-app', max: 8 });
  // The admin query handle has its own pool; close it too, or pg_terminate_backend
  // in destroy() kills a live client and surfaces an unhandled 57P01 error.
  const adminQuery = connect({ connectionString: withDb(adminUrl(), name), applicationName: 'evenbooks-test-admin', max: 2 });
  const admin: DbHandle = {
    pool: adminTarget,
    db: adminQuery.db,
    close: async () => {
      await adminQuery.close();
      await adminTarget.end();
    },
  };
  return {
    name,
    appUrl: appUrlStr,
    ownerUrl: ownerUrlStr,
    adminUrl: withDb(adminUrl(), name),
    app,
    owner,
    admin,
    async destroy() {
      await app.close();
      await owner.close();
      await admin.close();
      await adminPool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [name],
      );
      await adminPool.query(`drop database if exists "${name}"`);
      await adminPool.end();
    },
  };
}

/** Drop leftover test databases (used by global setup). */
export async function dropStaleTestDatabases(prefix = 'evenbooks_test'): Promise<number> {
  const pool = new Pool({ connectionString: adminUrl(), max: 1 });
  try {
    const { rows } = await pool.query<{ datname: string }>(
      `select datname from pg_database where datname like $1`,
      [`${prefix}_%`],
    );
    for (const r of rows) {
      await pool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`,
        [r.datname],
      );
      await pool.query(`drop database if exists "${r.datname}"`);
    }
    return rows.length;
  } finally {
    await pool.end();
  }
}
