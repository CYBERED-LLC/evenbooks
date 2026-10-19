import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { Db, Schema } from './client';

export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** Any executor: the root db or a transaction. */
export type Executor = Db | Tx;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenancyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenancyError';
  }
}

export interface CompanyContext {
  companyId: string;
  /** Clerk user id, or 'system' / job identifiers for background work. */
  actorId: string;
  actorType: 'user' | 'system' | 'job';
  requestId?: string;
  jobId?: string;
}

export interface TxOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
}

/**
 * Run `fn` in a transaction with the company row-level-security context set.
 * Every company-scoped read or write must go through here (or `withSystem`).
 */
export async function withCompany<T>(
  db: Db,
  ctx: CompanyContext,
  fn: (tx: Tx, ctx: CompanyContext) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  if (!UUID_RE.test(ctx.companyId)) throw new TenancyError('Invalid company id');
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('app.company_id', ${ctx.companyId}, true)`);
      await tx.execute(sql`select set_config('app.actor_id', ${ctx.actorId}, true)`);
      return fn(tx as Tx, ctx);
    },
    opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined,
  );
}

/**
 * System context: cross-company reads permitted by `system_read` policies (outbox
 * dispatch, company resolution, scheduling). Only the worker and the company
 * resolver may use this; never expose it to request handlers with user input.
 */
export async function withSystem<T>(db: Db, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('app.system', 'on', true)`);
      await tx.execute(sql`select set_config('app.actor_id', 'system', true)`);
      return fn(tx as Tx);
    },
    opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined,
  );
}

/**
 * System context plus a company context, for worker jobs that act on behalf of
 * one company (they need to write company rows and read scheduling tables).
 */
export async function withSystemCompany<T>(
  db: Db,
  ctx: CompanyContext,
  fn: (tx: Tx, ctx: CompanyContext) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  if (!UUID_RE.test(ctx.companyId)) throw new TenancyError('Invalid company id');
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('app.system', 'on', true)`);
      await tx.execute(sql`select set_config('app.company_id', ${ctx.companyId}, true)`);
      await tx.execute(sql`select set_config('app.actor_id', ${ctx.actorId}, true)`);
      return fn(tx as Tx, ctx);
    },
    opts.isolationLevel ? { isolationLevel: opts.isolationLevel } : undefined,
  );
}
