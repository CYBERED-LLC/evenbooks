import { eq } from 'drizzle-orm';
import { withCompany, withSystemCompany, schema, type CompanyContext, type Db, type Tx } from '@evenbooks/db';
import { withDbErrors } from './errors';
import { notFound } from './errors';

export type CompanyRow = typeof schema.companies.$inferSelect;

/**
 * Everything a service function needs: the tenant-scoped transaction, the
 * caller identity, and the company row (base currency, time zone, numbering).
 */
export interface ServiceContext {
  tx: Tx;
  ctx: CompanyContext;
  company: CompanyRow;
}

async function loadCompany(tx: Tx, companyId: string): Promise<CompanyRow> {
  const [row] = await tx.select().from(schema.companies).where(eq(schema.companies.id, companyId)).limit(1);
  if (!row) throw notFound('Company');
  return row;
}

/** Run a unit of work in the company's context. Used by request handlers. */
export function runInCompany<T>(db: Db, ctx: CompanyContext, fn: (s: ServiceContext) => Promise<T>): Promise<T> {
  return withDbErrors(() =>
    withCompany(db, ctx, async (tx) => {
      const company = await loadCompany(tx, ctx.companyId);
      return fn({ tx, ctx, company });
    }),
  );
}

/** Same for worker jobs (system + company context). */
export function runJobInCompany<T>(db: Db, ctx: CompanyContext, fn: (s: ServiceContext) => Promise<T>): Promise<T> {
  return withDbErrors(() =>
    withSystemCompany(db, ctx, async (tx) => {
      const company = await loadCompany(tx, ctx.companyId);
      return fn({ tx, ctx, company });
    }),
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}
