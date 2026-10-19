import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withCompany } from '@evenbooks/db';
import { LocalStorage } from '@evenbooks/integrations';
import {
  categorizeTransaction,
  commitBatch,
  completeReconciliation,
  createBankAccount,
  createContact,
  createItem,
  createPurchase,
  createRule,
  createTaxRate,
  excludeTransaction,
  getAttachment,
  getBankTransaction,
  getPurchase,
  getReconciliation,
  listAccounts,
  listInbox,
  listPurchases,
  matchCandidates,
  matchTransaction,
  previewCsv,
  startReconciliation,
  toggleReconciliationItems,
  transferTransaction,
  undoReview,
  uploadAttachment,
  voidPurchase,
  listReconciliations,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let storage: LocalStorage;
let tmpDir: string;
let checkingId: string; // bank account (banking) id
let cardId: string;
let vendorId: string;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-storage-'));
  storage = new LocalStorage(tmpDir);
  const checking = await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Main Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! }));
  const card = await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Business Visa', kind: 'credit_card', ledgerAccountId: acct.get('2000')! }));
  checkingId = checking.id;
  cardId = card.id;
  vendorId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Office Depot', isCustomer: false, isVendor: true }))).id;
});
afterAll(async () => {
  await w.destroy();
  await rm(tmpDir, { recursive: true, force: true });
});

async function balance(code: string): Promise<string> {
  const list = await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true, includeArchived: true }));
  return Number(list.find((a) => a.code === code)!.balance).toFixed(2);
}

describe('masters', () => {
  it('creates items and tax rates bound to the control account', async () => {
    const rate = await w.run(w.ctxA, (s) => createTaxRate(s, { name: 'State 8.25%', rate: '0.0825' }));
    expect(rate.liabilityAccountId).toBe(acct.get('2100'));
    const item = await w.run(w.ctxA, (s) => createItem(s, { name: 'Consulting hour', unitPrice: '150', incomeAccountId: acct.get('4100')!, defaultTaxRateIds: [rate.id], kind: 'service' }));
    expect(item.unitPrice).toBe('150');
    await expect(w.run(w.ctxA, (s) => createItem(s, { name: 'Bad', unitPrice: '1', incomeAccountId: acct.get('5110')!, defaultTaxRateIds: [], kind: 'service' }))).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('purchases', () => {
  it('posts a bank purchase, a card purchase and a vendor refund with correct sides', async () => {
    const p1 = await w.run(w.ctxA, (s) =>
      createPurchase(s, {
        date: '2026-03-02',
        contactId: vendorId,
        paidFromAccountId: acct.get('1000')!,
        direction: 'outflow',
        lines: [{ accountId: acct.get('5110')!, description: 'Paper', amount: '40' }, { accountId: acct.get('5080')!, description: 'Pens', amount: '10' }],
        attachmentIds: [],
      }),
    );
    expect(p1.total).toBe('50.00');
    expect(await balance('1000')).toBe('-50.00');
    expect(await balance('5110')).toBe('40.00');

    const p2 = await w.run(w.ctxA, (s) =>
      createPurchase(s, { date: '2026-03-03', paidFromAccountId: acct.get('2000')!, direction: 'outflow', lines: [{ accountId: acct.get('5160')!, description: 'SaaS', amount: '29.99' }], attachmentIds: [] }),
    );
    expect(p2.paidFromAccountName).toBe('Credit Card');
    expect(await balance('2000')).toBe('29.99'); // liability grew

    await w.run(w.ctxA, (s) =>
      createPurchase(s, { date: '2026-03-05', contactId: vendorId, paidFromAccountId: acct.get('1000')!, direction: 'inflow', lines: [{ accountId: acct.get('5110')!, description: 'Returned paper', amount: '15' }], attachmentIds: [] }),
    );
    expect(await balance('5110')).toBe('25.00');
    expect(await balance('1000')).toBe('-35.00');

    // cash recognition rows exist for all three at their dates
    const rec = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => (await tx.execute<{ total: string }>(sql`select sum(amount)::text as total from cash_recognitions where kind = 'expense'`)).rows[0]!.total);
    expect(Number(rec).toFixed(2)).toBe((40 + 10 + 29.99 - 15).toFixed(2));
  });

  it('two identical-looking purchases on the same day both survive', async () => {
    const mk = () =>
      w.run(w.ctxA, (s) => createPurchase(s, { date: '2026-03-06', paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5140')!, description: 'Coffee', amount: '4.50' }], attachmentIds: [] }));
    const a = await mk();
    const b = await mk();
    expect(a.id).not.toBe(b.id);
    const list = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 50, from: '2026-03-06', to: '2026-03-06' }));
    expect(list.items).toHaveLength(2);
  });

  it('voiding a purchase reverses the entry and refuses double voids', async () => {
    const p = await w.run(w.ctxA, (s) => createPurchase(s, { date: '2026-03-07', paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5000')!, description: 'Ad', amount: '100' }], attachmentIds: [] }));
    const before = await balance('5000');
    const voided = await w.run(w.ctxA, (s) => voidPurchase(s, p.id, { version: p.version, reason: 'Charged twice' }));
    expect(voided.status).toBe('void');
    expect(voided.voidJournalEntryId).toBeTruthy();
    expect(Number(await balance('5000'))).toBe(Number(before) - 100);
    await expect(w.run(w.ctxA, (s) => voidPurchase(s, p.id, { version: voided.version, reason: 'again' }))).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('receipts', () => {
  it('uploads a receipt, links it to a purchase, and hides it from other companies', async () => {
    const att = await w.run(w.ctxA, (s) => uploadAttachment(s, storage, { kind: 'receipt', fileName: 'receipt.pdf', contentType: 'application/pdf', body: new TextEncoder().encode('%PDF-1.4 test') }));
    expect(att.status).toBe('uploaded');
    expect(att.sha256).toHaveLength(64);
    const p = await w.run(w.ctxA, (s) => createPurchase(s, { date: '2026-03-08', paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5110')!, description: 'x', amount: '9' }], attachmentIds: [att.id] }));
    const full = await w.run(w.ctxA, (s) => getPurchase(s, p.id));
    expect(full.attachments?.map((a) => a.id)).toEqual([att.id]);
    await expect(w.run(w.ctxB, (s) => getAttachment(s, att.id))).rejects.toMatchObject({ code: 'not_found' });
    const stored = await storage.getObject(`companies/${w.companyA}/receipt/${att.id}.pdf`);
    expect(stored?.contentType).toBe('application/pdf');
    await expect(w.run(w.ctxA, (s) => uploadAttachment(s, storage, { kind: 'receipt', fileName: 'x.exe', contentType: 'application/x-msdownload', body: new Uint8Array([1]) }))).rejects.toMatchObject({ code: 'validation' });
  });
});

const CSV = `Date,Description,Amount
03/10/2026,COFFEE SHOP,-4.50
03/10/2026,COFFEE SHOP,-4.50
03/11/2026,ACH DEPOSIT CLIENT,1200.00
03/12/2026,TRANSFER TO VISA,-300.00
03/12/2026,OFFICE DEPOT #123,-50.00
notadate,BAD ROW,-1.00
`;

describe('CSV import and review inbox', () => {
  let batchId: string;

  it('previews with detected mapping, keeps identical rows, flags errors', async () => {
    const preview = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: checkingId, fileName: 'march.csv', content: CSV }));
    batchId = preview.id;
    expect(preview.mapping?.date).toBe('Date');
    expect(preview.mapping?.amounts.amount).toBe('Amount');
    expect(preview.rowCount).toBe(6);
    expect(preview.errorCount).toBe(1);
    expect(preview.duplicateCount).toBe(0);
    expect(preview.rows!.filter((r) => r.description === 'COFFEE SHOP' && r.status === 'ok')).toHaveLength(2);
    expect(preview.alreadyCommitted).toBe(false);
  });

  it('commits once; replaying the same file is fully duplicate and cannot commit twice', async () => {
    const committed = await w.run(w.ctxA, (s) => commitBatch(s, batchId));
    expect(committed.status).toBe('committed');
    expect(committed.importedCount).toBe(5);
    const inbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId }));
    expect(inbox.items).toHaveLength(5);
    expect(inbox.items.filter((t) => t.description === 'COFFEE SHOP')).toHaveLength(2);

    const again = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: checkingId, fileName: 'march-again.csv', content: CSV }));
    expect(again.alreadyCommitted).toBe(true);
    expect(again.duplicateCount).toBe(5);
    await expect(w.run(w.ctxA, (s) => commitBatch(s, again.id))).rejects.toMatchObject({ code: 'duplicate' });
    expect((await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId }))).items).toHaveLength(5);

    // the database refuses a duplicate fingerprint directly
    const [t] = (await w.run(w.ctxA, (s) => listInbox(s, { limit: 1, bankAccountId: checkingId }))).items;
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) =>
        tx.execute(sql`insert into bank_transactions (company_id, bank_account_id, source, fingerprint, date, amount, currency, description)
          select company_id, bank_account_id, 'csv', fingerprint, date, amount, currency, description from bank_transactions where id = ${t!.id}`),
      ),
    ).rejects.toThrow();
  });

  it('rules suggest an account; categorizing money out creates a purchase (split supported)', async () => {
    await w.run(w.ctxA, (s) => createRule(s, { name: 'Coffee', pattern: 'coffee', accountId: acct.get('5140')!, direction: 'out', matchField: 'description', matchType: 'contains', priority: 10 }));
    const inbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId, status: 'unreviewed' }));
    const coffee = inbox.items.filter((t) => t.description === 'COFFEE SHOP');
    expect(coffee[0]!.suggestion?.accountId).toBe(acct.get('5140'));

    const done = await w.run(w.ctxA, (s) =>
      categorizeTransaction(s, coffee[0]!.id, { version: coffee[0]!.version, lines: [{ accountId: acct.get('5140')!, amount: '4.50', description: 'Coffee' }] }),
    );
    expect(done.status).toBe('categorized');
    expect(done.journalEntryId).toBeTruthy();
    const purchases = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 10, from: '2026-03-10', to: '2026-03-10' }));
    expect(purchases.items.some((p) => p.bankTransactionId === coffee[0]!.id)).toBe(true);

    const depot = inbox.items.find((t) => t.description.startsWith('OFFICE DEPOT'))!;
    await expect(
      w.run(w.ctxA, (s) => categorizeTransaction(s, depot.id, { version: depot.version, lines: [{ accountId: acct.get('5110')!, amount: '30', description: '' }] })),
    ).rejects.toMatchObject({ code: 'validation' });
    const split = await w.run(w.ctxA, (s) =>
      categorizeTransaction(s, depot.id, {
        version: depot.version,
        contactId: vendorId,
        lines: [
          { accountId: acct.get('5110')!, amount: '30', description: 'Supplies' },
          { accountId: acct.get('5080')!, amount: '20', description: 'Office' },
        ],
      }),
    );
    expect(split.status).toBe('categorized');
  });

  it('money in that is not a customer payment posts income', async () => {
    const inbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId, status: 'unreviewed' }));
    const dep = inbox.items.find((t) => t.description === 'ACH DEPOSIT CLIENT')!;
    const before = await balance('4900');
    const done = await w.run(w.ctxA, (s) => categorizeTransaction(s, dep.id, { version: dep.version, lines: [{ accountId: acct.get('4900')!, amount: '1200', description: 'Misc income' }] }));
    expect(done.status).toBe('categorized');
    expect(Number(await balance('4900'))).toBe(Number(before) + 1200);
    await expect(
      w.run(w.ctxA, (s) => categorizeTransaction(s, dep.id, { version: done.version, lines: [{ accountId: acct.get('1100')!, amount: '1200', description: '' }] })),
    ).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('card payment transfer moves money between accounts without creating expense', async () => {
    // import the card side: a payment received on the card
    const cardCsv = `Date,Description,Amount\n03/13/2026,PAYMENT THANK YOU,300.00\n03/14/2026,AMAZON MARKETPLACE,-89.10\n`;
    const p = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: cardId, fileName: 'visa.csv', content: cardCsv }));
    await w.run(w.ctxA, (s) => commitBatch(s, p.id));
    const checkingInbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId, status: 'unreviewed' }));
    const out = checkingInbox.items.find((t) => t.description === 'TRANSFER TO VISA')!;
    const candidates = await w.run(w.ctxA, (s) => matchCandidates(s, out.id));
    const counterpart = candidates.find((c) => c.targetType === 'bank_transaction');
    expect(counterpart?.bankAccountName).toBe('Business Visa');

    const expenseBefore = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => (await tx.execute<{ t: string }>(sql`select coalesce(sum(amount),0)::text as t from cash_recognitions where kind='expense'`)).rows[0]!.t);
    const cardBefore = await balance('2000');
    const done = await w.run(w.ctxA, (s) => transferTransaction(s, out.id, { version: out.version, counterpartTransactionId: counterpart!.targetId }));
    expect(done.status).toBe('transfer');
    const other = await w.run(w.ctxA, (s) => getBankTransaction(s, counterpart!.targetId));
    expect(other.status).toBe('transfer');
    expect(other.journalEntryId).toBe(done.journalEntryId);
    expect(Number(await balance('2000'))).toBe(Number(cardBefore) - 300);
    const expenseAfter = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => (await tx.execute<{ t: string }>(sql`select coalesce(sum(amount),0)::text as t from cash_recognitions where kind='expense'`)).rows[0]!.t);
    expect(expenseAfter).toBe(expenseBefore);
  });

  it('card charge categorized is an expense at charge date (cash basis)', async () => {
    const cardInbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: cardId, status: 'unreviewed' }));
    const amz = cardInbox.items.find((t) => t.description === 'AMAZON MARKETPLACE')!;
    const done = await w.run(w.ctxA, (s) => categorizeTransaction(s, amz.id, { version: amz.version, lines: [{ accountId: acct.get('5110')!, amount: '89.10', description: 'Supplies' }] }));
    expect(done.status).toBe('categorized');
    const rows = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => (await tx.execute<{ date: string; amount: string }>(sql`select date, amount from cash_recognitions where journal_entry_id = ${done.journalEntryId}`)).rows);
    expect(rows).toEqual([{ date: '2026-03-14', amount: '89.100000' }]);
  });

  it('matching an existing purchase links evidence without double posting; undo restores', async () => {
    // Manually recorded purchase that later appears in the feed
    const manual = await w.run(w.ctxA, (s) => createPurchase(s, { date: '2026-03-20', paidFromAccountId: acct.get('1000')!, direction: 'outflow', lines: [{ accountId: acct.get('5050')!, description: 'Insurance', amount: '210' }], attachmentIds: [] }));
    const csv = `Date,Description,Amount\n03/21/2026,INSURANCE CO PREMIUM,-210.00\n03/22/2026,BANK SERVICE FEE,-12.00\n`;
    const pv = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: checkingId, fileName: 'late.csv', content: csv }));
    await w.run(w.ctxA, (s) => commitBatch(s, pv.id));
    const inbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId, status: 'unreviewed' }));
    const ins = inbox.items.find((t) => t.description.startsWith('INSURANCE'))!;
    const candidates = await w.run(w.ctxA, (s) => matchCandidates(s, ins.id));
    expect(candidates.some((c) => c.targetType === 'purchase' && c.targetId === manual.id)).toBe(true);
    const before = await balance('5050');
    const matched = await w.run(w.ctxA, (s) => matchTransaction(s, ins.id, { version: ins.version, targets: [{ targetType: 'purchase', targetId: manual.id }] }));
    expect(matched.status).toBe('matched');
    expect(await balance('5050')).toBe(before); // no double posting
    // the purchase can no longer be matched again
    const fee = inbox.items.find((t) => t.description === 'BANK SERVICE FEE')!;
    await expect(w.run(w.ctxA, (s) => matchTransaction(s, fee.id, { version: fee.version, targets: [{ targetType: 'purchase', targetId: manual.id }] }))).rejects.toMatchObject({ code: 'duplicate' });

    const undone = await w.run(w.ctxA, (s) => undoReview(s, matched.id, { version: matched.version }));
    expect(undone.status).toBe('unreviewed');
    const excluded = await w.run(w.ctxA, (s) => excludeTransaction(s, fee.id, { version: fee.version, reason: 'Personal' }));
    expect(excluded.status).toBe('excluded');
    const counts = (await w.run(w.ctxA, (s) => listInbox(s, { limit: 1, bankAccountId: checkingId }))).counts;
    expect(counts.excluded).toBe(1);
  });

  it('undoing a categorization voids the purchase and returns the line to the inbox', async () => {
    const inbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId, status: 'categorized' }));
    const coffee = inbox.items.find((t) => t.description === 'COFFEE SHOP')!;
    const before = await balance('5140');
    const undone = await w.run(w.ctxA, (s) => undoReview(s, coffee.id, { version: coffee.version, reason: 'Wrong account' }));
    expect(undone.status).toBe('unreviewed');
    expect(Number(await balance('5140'))).toBe(Number(before) - 4.5);
  });
});

describe('reconciliation', () => {
  it('reconciles the checking statement to zero discrepancy and flags on later reversal', async () => {
    // Statement for March: opening 0. Ledger lines on 1000 are all March dated.
    const accounts = await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true }));
    const ledger1000 = accounts.find((a) => a.code === '1000')!.balance!;
    const started = await w.run(w.ctxA, (s) =>
      startReconciliation(s, { bankAccountId: checkingId, statementStartDate: '2026-03-01', statementEndDate: '2026-03-31', statementOpeningBalance: '0', statementClosingBalance: Number(ledger1000).toFixed(2) }),
    );
    expect(started.lines.length).toBeGreaterThan(3);
    expect(Number(started.discrepancy)).not.toBe(0);
    await expect(w.run(w.ctxA, (s) => completeReconciliation(s, started.id, { version: started.version }))).rejects.toMatchObject({ code: 'validation' });

    const toggled = await w.run(w.ctxA, (s) => toggleReconciliationItems(s, started.id, { version: started.version, clear: started.lines.map((l) => l.journalLineId), unclear: [] }));
    expect(toggled.discrepancy).toBe('0.00');
    const completed = await w.run(w.ctxA, (s) => completeReconciliation(s, started.id, { version: toggled.version }));
    expect(completed.status).toBe('completed');

    // a second session cannot re-clear the same lines
    const second = await w.run(w.ctxA, (s) =>
      startReconciliation(s, { bankAccountId: checkingId, statementStartDate: '2026-04-01', statementEndDate: '2026-04-30', statementOpeningBalance: Number(ledger1000).toFixed(2), statementClosingBalance: Number(ledger1000).toFixed(2) }),
    );
    expect(second.lines.filter((l) => l.date <= '2026-03-31')).toHaveLength(0);
    expect(second.discrepancy).toBe('0.00');

    // void a reconciled purchase → the completed session is flagged for review
    const purchases = await w.run(w.ctxA, (s) => listPurchases(s, { limit: 50, status: 'posted', from: '2026-03-01', to: '2026-03-31' }));
    const target = purchases.items.find((p) => p.paidFromAccountId === acct.get('1000'))!;
    await w.run(w.ctxA, (s) => voidPurchase(s, target.id, { version: target.version, reason: 'Duplicate', date: '2026-04-02' }));
    const sessions = await w.run(w.ctxA, (s) => listReconciliations(s, checkingId));
    const march = sessions.find((x) => x.id === started.id)!;
    expect(march.status).toBe('flagged');
    expect(march.flaggedReason).toMatch(/voided/);
    const detail = await w.run(w.ctxA, (s) => getReconciliation(s, started.id));
    expect(detail.status).toBe('flagged');
  });
});
