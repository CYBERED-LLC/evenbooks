import 'server-only';
import { connect, needsSsl, waitForDatabase, type DbHandle } from '@evenbooks/db';
import { env } from './env';
import { logger } from './logger';

declare global {
  var __evenbooksDb: DbHandle | undefined;
  var __evenbooksDbReady: Promise<void> | undefined;
}

/** Process-wide connection pool (survives HMR in development via globalThis). */
export function getDb(): DbHandle {
  if (!globalThis.__evenbooksDb) {
    const url = env().databaseUrl;
    globalThis.__evenbooksDb = connect({
      connectionString: url,
      applicationName: 'evenbooks-web',
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      connectionTimeoutMillis: 10_000,
      ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return globalThis.__evenbooksDb;
}

/** Share concurrent wake-up probes, and probe again on later requests after idle sleep. */
export async function getReadyDb(): Promise<DbHandle> {
  const db = getDb();
  globalThis.__evenbooksDbReady ??= waitForDatabase(db.pool, {
    timeoutMs: 30_000,
    log: (message) => logger.info(message),
  }).finally(() => { globalThis.__evenbooksDbReady = undefined; });
  await globalThis.__evenbooksDbReady;
  return db;
}
