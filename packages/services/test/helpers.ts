import type { CompanyContext } from '@evenbooks/db';
import { createTestDatabase, type TestDatabase } from '@evenbooks/db/testing';
import { resolveCompanyForOrg, runInCompany, type ServiceContext } from '../src/index';

export interface TestWorld {
  tdb: TestDatabase;
  companyA: string;
  companyB: string;
  ctxA: CompanyContext;
  ctxB: CompanyContext;
  run<T>(ctx: CompanyContext, fn: (s: ServiceContext) => Promise<T>): Promise<T>;
  accountsByCode(ctx: CompanyContext): Promise<Map<string, string>>;
  destroy(): Promise<void>;
}

export async function createWorld(): Promise<TestWorld> {
  const tdb = await createTestDatabase();
  const a = await resolveCompanyForOrg(tdb.app.db, { clerkOrgId: 'org_a', name: 'Alpha LLC', actorId: 'user_a' });
  const b = await resolveCompanyForOrg(tdb.app.db, { clerkOrgId: 'org_b', name: 'Beta Inc', actorId: 'user_b' });
  const ctxA: CompanyContext = { companyId: a.id, actorId: 'user_a', actorType: 'user' };
  const ctxB: CompanyContext = { companyId: b.id, actorId: 'user_b', actorType: 'user' };
  const run = <T>(ctx: CompanyContext, fn: (s: ServiceContext) => Promise<T>) => runInCompany(tdb.app.db, ctx, fn);
  return {
    tdb,
    companyA: a.id,
    companyB: b.id,
    ctxA,
    ctxB,
    run,
    async accountsByCode(ctx) {
      const { listAccounts } = await import('../src/index.js');
      const list = await run(ctx, (s) => listAccounts(s, { includeArchived: true }));
      return new Map(list.map((x) => [x.code, x.id]));
    },
    destroy: () => tdb.destroy(),
  };
}

/** Full message chain of a (possibly drizzle-wrapped) database error. */
export function dbErrorMessage(err: unknown): string {
  const parts: string[] = [];
  let cur = err as { message?: string; cause?: unknown } | undefined;
  for (let i = 0; cur && typeof cur === 'object' && i < 5; i++) {
    if (cur.message) parts.push(cur.message);
    cur = cur.cause as typeof cur;
  }
  return parts.join(' <- ');
}
