import './load-env';
import { Pool } from 'pg';
import { bootstrapRoles, bootstrapDatabase } from '../src/bootstrap';
import { needsSsl } from '../src/env';
import { waitForDatabase } from '../src/wake';

/**
 * Usage: DATABASE_ADMIN_URL=postgres://superuser@host/postgres \
 *        EVENBOOKS_DB_NAME=evenbooks EVENBOOKS_OWNER_PASSWORD=... EVENBOOKS_APP_PASSWORD=... pnpm --filter @evenbooks/db bootstrap
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const database = process.env.EVENBOOKS_DB_NAME ?? 'evenbooks';
const ownerPassword = process.env.EVENBOOKS_OWNER_PASSWORD;
const appPassword = process.env.EVENBOOKS_APP_PASSWORD;
if (!adminUrl || !ownerPassword || !appPassword) {
  console.error('DATABASE_ADMIN_URL, EVENBOOKS_OWNER_PASSWORD and EVENBOOKS_APP_PASSWORD are required');
  process.exit(1);
}
const ssl = needsSsl(adminUrl) ? { rejectUnauthorized: false } : undefined;
const admin = new Pool({ connectionString: adminUrl, max: 1, ssl, connectionTimeoutMillis: 10_000 });
await waitForDatabase(admin, { log: console.log });
await bootstrapRoles(admin, { database, ownerPassword, appPassword, log: console.log });
const target = new URL(adminUrl);
target.pathname = `/${database}`;
const targetPool = new Pool({ connectionString: target.toString(), max: 1, ssl });
await bootstrapDatabase(targetPool, console.log);
await targetPool.end();
await admin.end();
console.log('bootstrap complete');
