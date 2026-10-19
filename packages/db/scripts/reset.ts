import './load-env';
import { Pool } from 'pg';
import { bootstrapRoles, bootstrapDatabase } from '../src/bootstrap';
import { migrate } from '../src/migrate';

/** Local development only: drop and recreate the database, then migrate. */
if (process.env.NODE_ENV === 'production') {
  console.error('refusing to reset in production');
  process.exit(1);
}
const adminUrl = process.env.DATABASE_ADMIN_URL;
const database = process.env.EVENBOOKS_DB_NAME ?? 'evenbooks';
const ownerPassword = process.env.EVENBOOKS_OWNER_PASSWORD ?? 'evenbooks_owner';
const appPassword = process.env.EVENBOOKS_APP_PASSWORD ?? 'evenbooks_app';
if (!adminUrl) {
  console.error('DATABASE_ADMIN_URL is required');
  process.exit(1);
}
const admin = new Pool({ connectionString: adminUrl, max: 1 });
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [database]);
await admin.query(`drop database if exists "${database}"`);
await bootstrapRoles(admin, { database, ownerPassword, appPassword, log: console.log });
const target = new URL(adminUrl);
target.pathname = `/${database}`;
const targetPool = new Pool({ connectionString: target.toString(), max: 1 });
await bootstrapDatabase(targetPool, console.log);
await targetPool.end();
await admin.end();
const ownerUrl = new URL(adminUrl);
ownerUrl.pathname = `/${database}`;
ownerUrl.username = 'evenbooks_owner';
ownerUrl.password = ownerPassword;
const owner = new Pool({ connectionString: ownerUrl.toString(), max: 1 });
const r = await migrate(owner, { log: console.log });
await owner.end();
console.log(`reset complete; applied ${r.applied.length} migrations`);
