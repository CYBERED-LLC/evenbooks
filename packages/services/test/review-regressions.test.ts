import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { LocalStorage } from '@evenbooks/integrations';
import { CreateRuleInput, UpdateRuleInput } from '@evenbooks/contracts';
import { createWorld, type TestWorld } from './helpers';
import {
  createBankAccount, createManualBankTransaction, categorizeTransaction, createPayment, getBankTransaction, listAccounts,
  getPayment, voidPayment, createContact, createDraftInvoice, issueInvoice, voidInvoice, getPublicLink, rotatePublicLink, revokePublicLink, getPublicInvoice,
  markStuckSendsUncertain, sendQueuedEmail, createRule, updateRule, createAccount, createLedgerImport, updateLedgerImport, commitLedgerImport,
  profitAndLoss, listEntries, reverseEntry, verifyCashRecognition, rebuildCashRecognition, reviewImportedCash, getEntry, closePeriod,
} from '../src/index';
import { ruleMatches } from '../src/rules';
let w: TestWorld;
let acct: Map<string, string>;
let bankId: string;
let tmp: string;
let storage: LocalStorage;
beforeAll(async () => {
  w = await createWorld(); acct = await w.accountsByCode(w.ctxA);
  bankId = (await w.run(w.ctxA, s => createBankAccount(s, { name: 'Review checking', kind: 'bank', ledgerAccountId: acct.get('1000')! }))).id;
  tmp = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-review-')); storage = new LocalStorage(tmp);
});
afterAll(async () => { await w.destroy(); await rm(tmp, { recursive: true, force: true }); });
const balance = async () => Number((await w.run(w.ctxA, s => listAccounts(s, { withBalances: true }))).find(a => a.code === '1000')!.balance);
const paymentInput = (bankTransactionId: string) => ({ date: '2026-06-01', amount: '100', depositAccountId: acct.get('1000')!, bankTransactionId, method: 'other' as const, allocations: [], isRefundableDeposit: false });
const bankLine = (amount = '100') => w.run(w.ctxA, s => createManualBankTransaction(s, { bankAccountId: bankId, date: '2026-06-01', amount, description: 'Deposit' }));

it('rejects already reviewed, wrong amount, wrong account and other-company bank lines without posting', async () => {
  const t = await bankLine();
  const categorized = await w.run(w.ctxA, s => categorizeTransaction(s, t.id, { version: t.version, lines: [{ accountId: acct.get('4100')!, amount: '100', description: 'Revenue' }] }));
  const before = await balance();
  await expect(w.run(w.ctxA, s => createPayment(s, paymentInput(t.id)))).rejects.toMatchObject({ code: 'invalid_state' });
  expect((await w.run(w.ctxA, s => getBankTransaction(s, t.id))).journalEntryId).toBe(categorized.journalEntryId);
  const wrongAmount = await bankLine('200');
  await expect(w.run(w.ctxA, s => createPayment(s, paymentInput(wrongAmount.id)))).rejects.toMatchObject({ code: 'validation' });
  const wrongAccount = await bankLine();
  const otherDeposit = await w.run(w.ctxA, s => createAccount(s, { code: '1095', name: 'Other bank', type: 'asset', role: 'bank' }));
  await expect(w.run(w.ctxA, s => createPayment(s, { ...paymentInput(wrongAccount.id), depositAccountId: otherDeposit.id }))).rejects.toMatchObject({ code: 'validation' });
  const bAccounts = await w.accountsByCode(w.ctxB);
  await expect(w.run(w.ctxB, s => createPayment(s, { ...paymentInput(wrongAccount.id), depositAccountId: bAccounts.get('1000')! }))).rejects.toMatchObject({ code: 'not_found' });
  expect(await balance()).toBe(before);
});
it('voiding a legacy mismatched payment preserves the bank line belonging to another entry', async () => {
  const t = await bankLine();
  const categorized = await w.run(w.ctxA, s => categorizeTransaction(s, t.id, { version: t.version, lines: [{ accountId: acct.get('4100')!, amount: '100', description: 'Revenue' }] }));
  const input = paymentInput(t.id);
  const p = await w.run(w.ctxA, s => createPayment(s, { ...input, bankTransactionId: undefined }));
  await w.run(w.ctxA, s => s.tx.execute(sql`update payments set bank_transaction_id=${t.id} where id=${p.id}`));
  const current = await w.run(w.ctxA, s => getPayment(s, p.id));
  await w.run(w.ctxA, s => voidPayment(s, p.id, { version: current.version, reason: 'Repair legacy duplicate' }));
  expect(await w.run(w.ctxA, s => getBankTransaction(s, t.id))).toMatchObject({ status: 'categorized', journalEntryId: categorized.journalEntryId });
});
it('only one concurrent payment can claim a bank transaction', async () => {
  const t = await bankLine(); const before = await balance();
  const results = await Promise.allSettled([w.run(w.ctxA, s => createPayment(s, paymentInput(t.id))), w.run(w.ctxA, s => createPayment(s, paymentInput(t.id)))]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await balance()).toBe(before + 100);
});
it('a rule toggle preserves all matching settings and unsafe regex never executes', async () => {
  expect(UpdateRuleInput.parse({ version: 1, isActive: false })).toEqual({ version: 1, isActive: false });
  const r = await w.run(w.ctxA, s => createRule(s, { name: 'Payroll', pattern: 'pay', accountId: acct.get('5110')!, priority: 3, direction: 'out', matchField: 'payee', matchType: 'starts_with' }));
  const changed = await w.run(w.ctxA, s => updateRule(s, r.id, UpdateRuleInput.parse({ version: r.version, isActive: false })));
  expect(changed).toMatchObject({ priority: 3, direction: 'out', matchField: 'payee', matchType: 'starts_with', isActive: false });
  expect(CreateRuleInput.safeParse({ name: 'Unsafe', accountId: acct.get('5110'), pattern: '^(a+)+$', matchType: 'regex' }).success).toBe(false);
  expect(UpdateRuleInput.safeParse({ version: 1, matchType: 'regex' }).success).toBe(false);
  expect(ruleMatches({ ...r, matchType: 'regex', pattern: '^(a+)+$', direction: 'any', matchField: 'description' } as never, { description: 'a'.repeat(40) + '!', payee: null, amount: '100', bankAccountId: bankId })).toBe(false);
});
it('get never reactivates revoked links, rotate is explicit, and void invoices remain private', async () => {
  const c = await w.run(w.ctxA, s => createContact(s, { name: 'Review customer', isCustomer: true, isVendor: false }));
  const draft = await w.run(w.ctxA, s => createDraftInvoice(s, { contactId: c.id, issueDate: '2026-06-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '100', incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }));
  const inv = await w.run(w.ctxA, s => issueInvoice(s, draft.id, { version: draft.version }));
  const link = await w.run(w.ctxA, s => getPublicLink(s, inv.id, 'https://evenbooks.test'));
  const token = link.path!.split('/').pop()!;
  await w.run(w.ctxA, s => revokePublicLink(s, inv.id));
  expect(await w.run(w.ctxA, s => getPublicLink(s, inv.id, 'https://evenbooks.test'))).toEqual({ url: null, path: null });
  expect(await getPublicInvoice(w.tdb.app.db, token)).toBeNull();
  const rotated = await w.run(w.ctxA, s => rotatePublicLink(s, inv.id, 'https://evenbooks.test'));
  expect(rotated.path).not.toBe(link.path);
  expect(await getPublicInvoice(w.tdb.app.db, token)).toBeNull();
  const current = await getEntryVersion(inv.id);
  await w.run(w.ctxA, s => voidInvoice(s, inv.id, { version: current, reason: 'Review' }));
  await expect(w.run(w.ctxA, s => getPublicLink(s, inv.id, 'https://evenbooks.test'))).rejects.toMatchObject({ code: 'invalid_state' });
  await expect(w.run(w.ctxA, s => rotatePublicLink(s, inv.id, 'https://evenbooks.test'))).rejects.toMatchObject({ code: 'invalid_state' });
  // Even a legacy void invoice whose revocation flag is missing must stay private.
  await w.run(w.ctxA, s => s.tx.execute(sql`update invoices set public_token_revoked_at=null where id=${inv.id}`));
  expect(await getPublicInvoice(w.tdb.app.db, rotated.path.split('/').pop()!)).toBeNull();
});
async function getEntryVersion(invoiceId: string) {
  return w.run(w.ctxA, async s => (await s.tx.execute<{version: number}>(sql`select version from invoices where id=${invoiceId}`)).rows[0]!.version);
}
it('recovers stale sends across companies without changing recent sends or completed messages', async () => {
  const ids: string[] = [];
  for (const ctx of [w.ctxA, w.ctxB]) {
    const rows = await w.run(ctx, s => s.tx.execute<{ id: string }>(sql`insert into email_messages(company_id,kind,to_email,subject,status,requested_by) values(${ctx.companyId},'invoice','test@example.com','Test','sending','review') returning id`));
    ids.push(rows.rows[0]!.id);
  }
  await w.tdb.admin.db.execute(sql`alter table email_messages disable trigger email_messages_touch`);
  await w.tdb.admin.db.execute(sql`update email_messages set updated_at=now()-interval '1 hour' where id in (${ids[0]},${ids[1]})`);
  await w.tdb.admin.db.execute(sql`alter table email_messages enable trigger email_messages_touch`);
  const recent = await w.run(w.ctxA, s => s.tx.execute<{id: string}>(sql`insert into email_messages(company_id,kind,to_email,subject,status,requested_by) values(${w.companyA},'invoice','recent@example.com','Test','sending','review') returning id`));
  expect(await markStuckSendsUncertain(w.tdb.app.db)).toBe(2);
  for (const [i, ctx] of [w.ctxA, w.ctxB].entries()) expect((await w.run(ctx, s => s.tx.execute<{status: string}>(sql`select status from email_messages where id=${ids[i]}`))).rows[0]!.status).toBe('uncertain');
  expect((await w.run(w.ctxA, s => s.tx.execute<{status: string}>(sql`select status from email_messages where id=${recent.rows[0]!.id}`))).rows[0]!.status).toBe('sending');
  expect(await markStuckSendsUncertain(w.tdb.app.db)).toBe(0);
  expect(await sendQueuedEmail({ db: w.tdb.app.db } as never, ids[0]!, null)).toEqual({ status: 'uncertain' });
});

it('requires settlement review and recognizes gross revenue plus fees on the collection date, including rebuild and reversal', async () => {
  const ar = await w.run(w.ctxA, s => createAccount(s, { code: '1195', name: 'Legacy receivables', type: 'asset' }));
  const content = 'Transaction ID,Date,Account,Description,Debit,Credit\nI,2027-01-01,Legacy receivables,Invoice,1000,\nI,2027-01-01,Service Income,Invoice,,1000\nP,2027-02-01,Checking Account,Collection,498.38,\nP,2027-02-01,Bank Fees,Collection,1.62,\nP,2027-02-01,Legacy receivables,Collection,,500';
  const imp = await w.run(w.ctxA, s => createLedgerImport(s, storage, { fileName: 'review.csv', content }));
  const mapped = await w.run(w.ctxA, s => updateLedgerImport(s, storage, imp.id, { accountMap: { 'Legacy receivables': ar.id, 'Service Income': acct.get('4100')!, 'Checking Account': acct.get('1000')!, 'Bank Fees': acct.get('5160')! } }));
  const collection = mapped.entries!.find(e => e.key === 'P')!;
  expect(collection.cashReviewRequired).toBe(true);
  await expect(w.run(w.ctxA, s => commitLedgerImport(s, storage, imp.id))).rejects.toMatchObject({ code: 'validation', message: /cash-basis/ });
  await w.run(w.ctxA, s => updateLedgerImport(s, storage, imp.id, { cashOverrides: { [collection.cashKey!]: [{ accountId: acct.get('4100')!, amount: '500' }, { accountId: acct.get('5160')!, amount: '1.62' }] } }));
  await w.run(w.ctxA, s => commitLedgerImport(s, storage, imp.id));
  const cash = await w.run(w.ctxA, s => profitAndLoss(s, { from: '2027-02-01', to: '2027-02-28', basis: 'cash' }));
  expect(cash).toMatchObject({ totalIncome: '500.00', totalExpenses: '1.62' });
  expect((await w.run(w.ctxA, s => profitAndLoss(s, { from: '2027-01-01', to: '2027-01-31', basis: 'cash' }))).totalIncome).toBe('0.00');
  expect((await w.run(w.ctxA, s => verifyCashRecognition(s))).ok).toBe(true);
  await w.run(w.ctxA, s => rebuildCashRecognition(s, 'Review test'));
  const entry = (await w.run(w.ctxA, s => listEntries(s, { limit: 50 } as never))).items.find(e => e.sourceId === imp.id && e.date === '2027-02-01')!;
  const reversal = await w.run(w.ctxA, s => reverseEntry(s, entry.id, { date: '2027-03-01', reason: 'Review reversal' }));
  await w.run(w.ctxA, s => reverseEntry(s, reversal.id, { date: '2027-04-01', reason: 'Undo review reversal' }));
  expect((await w.run(w.ctxA, s => profitAndLoss(s, { from: '2027-04-01', to: '2027-04-30', basis: 'cash' }))).totalIncome).toBe('500.00');
  expect((await w.run(w.ctxA, s => profitAndLoss(s, { from: '2027-03-01', to: '2027-03-31', basis: 'cash' }))).totalIncome).toBe('-500.00');
  expect((await w.run(w.ctxA, s => verifyCashRecognition(s))).ok).toBe(true);
  // Emulate an older import lacking cash metadata, then correct it through the admin service.
  await w.run(w.ctxA, s => s.tx.execute(sql`update journal_entries set cash_components=null where id=${entry.id}`));
  await w.run(w.ctxA, s => rebuildCashRecognition(s, 'Emulate legacy recognition'));
  await expect(w.run(w.ctxA, s => profitAndLoss(s, { from: '2027-02-01', to: '2027-02-28', basis: 'cash' }))).rejects.toMatchObject({ code: 'invalid_state', details: { journalEntryId: entry.id } });
  await expect(w.run(w.ctxA, s => profitAndLoss(s, { from: '2027-04-01', to: '2027-04-30', basis: 'cash' }))).rejects.toMatchObject({ code: 'invalid_state' });
  const current = await w.run(w.ctxA, s => getEntry(s, entry.id));
  const reviewed = await w.run(w.ctxA, s => reviewImportedCash(s, entry.id, { version: current.version, reason: 'Correct legacy collection', components: [{ accountId: acct.get('4100')!, amount: '500' }, { accountId: acct.get('5160')!, amount: '1.62' }] }));
  expect((await w.run(w.ctxA, s => verifyCashRecognition(s))).ok).toBe(true);
  await expect(w.run(w.ctxB, s => reviewImportedCash(s, entry.id, { version: reviewed.version, reason: 'Wrong company', components: [] }))).rejects.toMatchObject({ code: 'not_found' });
  await w.run(w.ctxA, s => closePeriod(s, { startDate: '2027-03-01', endDate: '2027-03-31' }));
  await expect(w.run(w.ctxA, s => reviewImportedCash(s, entry.id, { version: reviewed.version, reason: 'Locked reversal', components: [] }))).rejects.toMatchObject({ code: 'period_locked' });
});
