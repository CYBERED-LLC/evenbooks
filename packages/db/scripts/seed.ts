import './load-env';
import { Pool } from 'pg';
import { connect } from '../src/client';
import { needsSsl } from '../src/env';
import {
  categorizeTransaction,
  commitBatch,
  createBankAccount,
  createContact,
  createDraftInvoice,
  createItem,
  createManualJournal,
  createPayment,
  createPurchase,
  createRule,
  createTaxRate,
  issueInvoice,
  listAccounts,
  listInbox,
  previewCsv,
  resolveCompanyForOrg,
  runInCompany,
  type ServiceContext,
} from '@evenbooks/services';
import { createStorageFromEnv } from '@evenbooks/integrations';

/**
 * Demo / performance seed. Local development only.
 *
 *   pnpm --filter @evenbooks/db seed                # demo data for the two dev companies
 *   SEED_SCALE=12000 pnpm --filter @evenbooks/db seed  # plus ~12,000 bank transactions in Alpha for performance checks
 *
 * Idempotent-ish: re-running adds more data with fresh names; reset the database first
 * with `pnpm db:reset` for a clean slate.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
if ((process.env.APP_ENV ?? process.env.NODE_ENV) === 'production') throw new Error('refusing to seed in production');

const handle = connect({ connectionString: url, applicationName: 'evenbooks-seed', max: 4, ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined });
const storage = createStorageFromEnv();
const scale = Number(process.env.SEED_SCALE ?? 0);

function rnd(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

async function seedCompany(orgId: string, name: string, actor: string, heavy: boolean) {
  const company = await resolveCompanyForOrg(handle.db, { clerkOrgId: orgId, name, actorId: actor });
  const ctx = { companyId: company.id, actorId: actor, actorType: 'user' as const };
  const run = <T>(fn: (s: ServiceContext) => Promise<T>) => runInCompany(handle.db, ctx, fn);
  const accounts = await run((s) => listAccounts(s));
  const byCode = new Map(accounts.map((a) => [a.code, a.id]));
  const suffix = Date.now().toString(36).slice(-4);
  console.log(`seeding ${name} (${company.id})`);

  const tax = await run((s) => createTaxRate(s, { name: `State sales tax ${suffix}`, rate: '0.0825' }));
  const customers = await Promise.all(['Northwind Traders', 'Contoso Ltd', 'Fabrikam Inc', 'Blue Yonder Airlines'].map((n) => run((s) => createContact(s, { name: `${n} ${suffix}`, isCustomer: true, isVendor: false, email: `${n.split(' ')[0]!.toLowerCase()}@example.test` }))));
  const vendors = await Promise.all(['Office Depot', 'AWS', 'Landlord LLC', 'Coffee Roasters'].map((n) => run((s) => createContact(s, { name: `${n} ${suffix}`, isCustomer: false, isVendor: true }))));
  await run((s) => createItem(s, { name: `Consulting hour ${suffix}`, unitPrice: '175', incomeAccountId: byCode.get('4100')!, defaultTaxRateIds: [], kind: 'service' }));
  await run((s) => createItem(s, { name: `Website package ${suffix}`, unitPrice: '2500', incomeAccountId: byCode.get('4000')!, defaultTaxRateIds: [tax.id], kind: 'product' }));

  const checking = await run((s) => createBankAccount(s, { name: `Business Checking ${suffix}`, kind: 'bank', ledgerAccountId: byCode.get('1000')! })).catch(async () =>
    run((s) => createBankAccount(s, { name: `Business Checking ${suffix}`, kind: 'bank', newLedgerAccount: { code: `10${suffix}`, name: `Checking ${suffix}` } })),
  );
  await run((s) => createManualJournal(s, { date: '2026-01-02', memo: 'Owner investment', cashTreatment: 'exclude', post: true, lines: [{ accountId: checking.ledgerAccountId, debit: '25000' }, { accountId: byCode.get('3000')!, credit: '25000' }] }));

  // invoices + payments across the year
  const r = rnd(42);
  for (let m = 1; m <= 8; m++) {
    const c = customers[m % customers.length]!;
    const date = `2026-${String(m).padStart(2, '0')}-05`;
    const draft = await run((s) =>
      createDraftInvoice(s, {
        contactId: c.id,
        issueDate: date,
        lines: [
          { description: 'Consulting hours', quantity: String(10 + Math.floor(r() * 30)), unitPrice: '175', incomeAccountId: byCode.get('4100')!, taxRateIds: [] },
          ...(m % 3 === 0 ? [{ description: 'Website package', quantity: '1', unitPrice: '2500', incomeAccountId: byCode.get('4000')!, taxRateIds: [tax.id] }] : []),
        ],
      }),
    );
    const inv = await run((s) => issueInvoice(s, draft.id, { version: draft.version }));
    if (m <= 6) {
      const partial = m % 2 === 0;
      const amt = partial ? (Number(inv.total) / 2).toFixed(2) : inv.total;
      await run((s) => createPayment(s, { contactId: c.id, date: `2026-${String(m).padStart(2, '0')}-20`, amount: amt, method: 'ach', depositAccountId: checking.ledgerAccountId, isRefundableDeposit: false, allocations: [{ invoiceId: inv.id, amount: amt }] }));
    }
  }
  // purchases
  for (let m = 1; m <= 9; m++) {
    const date = `2026-${String(m).padStart(2, '0')}-10`;
    await run((s) => createPurchase(s, { date, contactId: vendors[2]!.id, paidFromAccountId: checking.ledgerAccountId, direction: 'outflow', lines: [{ accountId: byCode.get('5090')!, description: 'Office rent', amount: '1800' }], attachmentIds: [] }));
    await run((s) => createPurchase(s, { date, contactId: vendors[1]!.id, paidFromAccountId: byCode.get('2000')!, direction: 'outflow', lines: [{ accountId: byCode.get('5160')!, description: 'Cloud hosting', amount: (120 + Math.floor(r() * 80)).toFixed(2) }], attachmentIds: [] }));
  }
  await run((s) => createRule(s, { name: `Coffee ${suffix}`, pattern: 'coffee', accountId: byCode.get('5140')!, direction: 'out', matchField: 'description', matchType: 'contains', priority: 10 }));

  // bank feed CSV
  const count = heavy && scale > 0 ? scale : 60;
  const lines = ['Date,Description,Amount'];
  const descs = ['COFFEE ROASTERS', 'AMAZON MKTPLACE', 'UBER TRIP', 'CLIENT ACH DEPOSIT', 'GAS STATION', 'OFFICE SUPPLY CO', 'PARKING', 'SOFTWARE SUBSCRIPTION'];
  for (let i = 0; i < count; i++) {
    const day = 1 + Math.floor(r() * 28);
    const month = 1 + Math.floor(r() * 9);
    const d = descs[Math.floor(r() * descs.length)]!;
    const amount = d.includes('DEPOSIT') ? (500 + Math.floor(r() * 4000)).toFixed(2) : `-${(5 + r() * 400).toFixed(2)}`;
    lines.push(`${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/2026,${d} #${i},${amount}`);
  }
  const preview = await run((s) => previewCsv(s, storage, { bankAccountId: checking.id, fileName: `seed-${suffix}.csv`, content: lines.join('\n') + '\n' }));
  await run((s) => commitBatch(s, preview.id));
  // categorize a portion so reports have cash-basis data
  const inbox = await run((s) => listInbox(s, { limit: 200, bankAccountId: checking.id, status: 'unreviewed' }));
  let n = 0;
  for (const t of inbox.items) {
    if (n++ >= Math.min(120, inbox.items.length)) break;
    const out = Number(t.amount) < 0;
    const account = out ? byCode.get(t.description.includes('COFFEE') ? '5140' : t.description.includes('SOFTWARE') ? '5160' : '5900')! : byCode.get('4900')!;
    await run((s) => categorizeTransaction(s, t.id, { version: t.version, lines: [{ accountId: account, amount: Math.abs(Number(t.amount)).toFixed(2), description: t.description }] })).catch((e) => console.warn('categorize skipped', (e as Error).message));
  }
  console.log(`  ${name}: ${count} bank transactions imported, ${Math.min(120, inbox.items.length)} categorized`);
}

try {
  await seedCompany('org_dev_alpha', 'Alpha Consulting LLC', 'user_dev_owner', true);
  await seedCompany('org_dev_beta', 'Beta Design Studio', 'user_dev_owner', false);
  console.log('seed complete');
} finally {
  await handle.close();
}
export { Pool };
