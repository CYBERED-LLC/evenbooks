import { Pool, TypeOverrides, types, type PoolConfig } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;

/**
 * Keep exact numeric/bigint values as strings; the application never runs
 * financial arithmetic on JavaScript numbers.
 */
function typeOverrides(): TypeOverrides {
  const overrides = new TypeOverrides();
  overrides.setTypeParser(types.builtins.NUMERIC, (v: string) => v);
  overrides.setTypeParser(types.builtins.INT8, (v: string) => v);
  // dates as YYYY-MM-DD strings, timestamps as ISO strings
  overrides.setTypeParser(types.builtins.DATE, (v: string) => v);
  overrides.setTypeParser(types.builtins.TIMESTAMPTZ, (v: string) => new Date(v).toISOString());
  return overrides;
}

export interface CreatePoolOptions {
  connectionString: string;
  applicationName?: string;
  max?: number;
  ssl?: PoolConfig['ssl'];
  connectionTimeoutMillis?: number;
}

export function createPool(opts: CreatePoolOptions): Pool {
  return new Pool({
    connectionString: opts.connectionString,
    application_name: opts.applicationName ?? 'evenbooks',
    max: opts.max ?? 10,
    types: typeOverrides(),
    ssl: opts.ssl,
    connectionTimeoutMillis: opts.connectionTimeoutMillis,
    // Postgres GUCs are transaction-local via set_config(..., true); make sure a
    // stuck client cannot hold a company context forever.
    idle_in_transaction_session_timeout: 60_000,
    statement_timeout: 60_000,
  } as PoolConfig);
}

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema, casing: 'snake_case' });
}

export interface DbHandle {
  pool: Pool;
  db: Db;
  close(): Promise<void>;
}

export function connect(opts: CreatePoolOptions): DbHandle {
  const pool = createPool(opts);
  const db = createDb(pool);
  return { pool, db, close: () => pool.end() };
}
