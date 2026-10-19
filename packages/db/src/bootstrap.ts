import type { Pool } from 'pg';

/**
 * Creates the two runtime roles. Must run as a superuser (or a role with
 * CREATEROLE + CREATEDB) once per database cluster/environment:
 *
 *  - evenbooks_owner: owns schema objects; runs migrations. NOSUPERUSER so FORCE
 *    ROW LEVEL SECURITY applies to it too.
 *  - evenbooks_app: application/worker role. NOBYPASSRLS, no DDL. All access is
 *    filtered by company context.
 */
export interface BootstrapOptions {
  database: string;
  ownerPassword: string;
  appPassword: string;
  log?: (msg: string) => void;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

export async function bootstrapRoles(admin: Pool, opts: BootstrapOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const client = await admin.connect();
  try {
    const roleExists = async (r: string) =>
      (await client.query('select 1 from pg_roles where rolname = $1', [r])).rowCount === 1;

    if (!(await roleExists('evenbooks_owner'))) {
      await client.query(`create role evenbooks_owner login nosuperuser nobypassrls noinherit password '${esc(opts.ownerPassword)}'`);
      log('created role evenbooks_owner');
    } else {
      await client.query(`alter role evenbooks_owner with login password '${esc(opts.ownerPassword)}'`);
    }
    if (!(await roleExists('evenbooks_app'))) {
      await client.query(`create role evenbooks_app login nosuperuser nobypassrls noinherit password '${esc(opts.appPassword)}'`);
      log('created role evenbooks_app');
    } else {
      await client.query(`alter role evenbooks_app with login password '${esc(opts.appPassword)}'`);
    }
    const dbExists = (await client.query('select 1 from pg_database where datname = $1', [opts.database])).rowCount === 1;
    if (!dbExists) {
      await client.query(`create database ${ident(opts.database)} owner evenbooks_owner`);
      log(`created database ${opts.database}`);
    } else {
      await client.query(`alter database ${ident(opts.database)} owner to evenbooks_owner`);
    }
  } finally {
    client.release();
  }
}

/** Run once connected to the target database as a superuser: hand schema public to the owner. */
export async function bootstrapDatabase(target: Pool, log: (msg: string) => void = () => {}): Promise<void> {
  await target.query('alter schema public owner to evenbooks_owner');
  await target.query('grant usage on schema public to evenbooks_app');
  // extensions require superuser on many hosts; create them here so migrations can rely on them
  await target.query('create extension if not exists btree_gist');
  // pg-boss manages its own schema; the runtime role owns it so it can run its migrations.
  await target.query('create schema if not exists pgboss authorization evenbooks_app');
  // pg-boss issues CREATE SCHEMA IF NOT EXISTS on start, which needs CREATE on the database.
  const { rows } = await target.query<{ db: string }>('select current_database() as db');
  await target.query(`grant create on database ${ident(rows[0]!.db)} to evenbooks_app`);
  log('schema public owned by evenbooks_owner; pgboss schema owned by evenbooks_app; btree_gist installed');
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}
