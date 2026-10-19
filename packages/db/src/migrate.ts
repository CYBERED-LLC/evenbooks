import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

/**
 * Minimal, explicit SQL migration runner.
 *
 * - Files in `migrations/` named `NNNN_name.sql`, applied in lexical order.
 * - Each file runs inside one transaction; the run holds an advisory lock so
 *   concurrent deploys cannot double-apply.
 * - Applied files are recorded with their sha256; a changed historical file is
 *   an error (write a new migration instead).
 *
 * Migrations must run as the table-owner role (`evenbooks_owner`), never as the
 * application role.
 */

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const LOCK_KEY = 7_242_001;

export interface MigrationFile {
  name: string;
  sql: string;
  sha256: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  return Promise.all(
    entries.map(async (name) => {
      const sqlText = await readFile(path.join(dir, name), 'utf8');
      return { name, sql: sqlText, sha256: createHash('sha256').update(sqlText).digest('hex') };
    }),
  );
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: Pool, opts: { dir?: string; log?: (msg: string) => void } = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  const files = await loadMigrations(opts.dir);
  const client = await pool.connect();
  const result: MigrateResult = { applied: [], skipped: [] };
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        sha256 text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ name: string; sha256: string }>('select name, sha256 from schema_migrations');
    const applied = new Map(rows.map((r) => [r.name, r.sha256]));
    for (const file of files) {
      const existing = applied.get(file.name);
      if (existing) {
        if (existing !== file.sha256) {
          throw new Error(`Migration ${file.name} was modified after being applied (sha mismatch)`);
        }
        result.skipped.push(file.name);
        continue;
      }
      log(`applying ${file.name}`);
      await client.query('begin');
      try {
        await client.query(file.sql);
        await client.query('insert into schema_migrations (name, sha256) values ($1, $2)', [file.name, file.sha256]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(file.name);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return result;
}
