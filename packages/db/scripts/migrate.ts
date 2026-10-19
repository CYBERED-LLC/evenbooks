import './load-env';
import { Pool } from 'pg';
import { migrate } from '../src/migrate';
import { needsSsl } from '../src/env';
import { waitForDatabase } from '../src/wake';

const url = process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL (or DATABASE_URL) must be set');
  process.exit(1);
}
const pool = new Pool({ connectionString: url, max: 1, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10_000 });
try {
  await waitForDatabase(pool, { log: (m) => console.log(m) });
  const result = await migrate(pool, { log: (m) => console.log(m) });
  console.log(`applied ${result.applied.length}, already applied ${result.skipped.length}`);
} finally {
  await pool.end();
}
