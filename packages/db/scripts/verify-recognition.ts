import './load-env';
import { connect } from '../src/client';
import { needsSsl } from '../src/env';
import { withSystem, schema } from '../src/index';
import { runInCompany, verifyCashRecognition, rebuildCashRecognition } from '@evenbooks/services';

/**
 * Recompute cash recognition from source documents for every company and report drift.
 *   pnpm --filter @evenbooks/db exec tsx scripts/verify-recognition.ts           # verify only
 *   REBUILD=1 pnpm --filter @evenbooks/db exec tsx scripts/verify-recognition.ts # rebuild where drift is found
 */
const url = process.env.DATABASE_URL!;
const handle = connect({ connectionString: url, applicationName: 'evenbooks-verify', max: 2, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined });
try {
  const companies = await withSystem(handle.db, (tx) => tx.select({ id: schema.companies.id, name: schema.companies.name }).from(schema.companies));
  let bad = 0;
  for (const c of companies) {
    const ctx = { companyId: c.id, actorId: 'verify-script', actorType: 'system' as const };
    const r = await runInCompany(handle.db, ctx, (s) => verifyCashRecognition(s));
    console.log(`${c.name}: ${r.ok ? 'OK' : 'DRIFT'} stored=${r.storedRows} derived=${r.derivedRows} diffs=${r.diffs.length}`);
    for (const d of r.diffs.slice(0, 20)) console.log(`  ${d.date} ${d.accountId} stored=${d.stored} derived=${d.derived}`);
    if (!r.ok) {
      bad++;
      if (process.env.REBUILD === '1') {
        const rb = await runInCompany(handle.db, ctx, (s) => rebuildCashRecognition(s, 'verify-recognition script'));
        console.log(`  rebuilt ${rb.rows} rows`);
      }
    }
  }
  process.exitCode = bad ? 1 : 0;
} finally {
  await handle.close();
}
