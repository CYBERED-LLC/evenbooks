import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withCompany } from '@evenbooks/db';
import { LocalStorage } from '@evenbooks/integrations';
import {
  allocatePayment,
  applyCreditNote,
  categorizeTransaction,
  closePeriod,
  commitBatch,
  createAccount,
  completeReconciliation,
  createBankAccount,
  createContact,
  createDraftCreditNote,
  createDraftInvoice,
  createManualBankTransaction,
  createManualJournal,
  createPayment,
  createRefund,
  deleteRecord,
  getBankTransaction,
  getCreditNote,
  getInvoice,
  getPayment,
  getReconciliation,
  issueCreditNote,
  issueInvoice,
  listAccounts,
  listAudit,
  listInbox,
  matchTransaction,
  previewCsv,
  previewDeletion,
  rebuildCashRecognition,
  reopenPeriod,
  reverseEntry,
  startReconciliation,
  toggleReconciliationItems,
  transferTransaction,
  updateCompany,
  verifyCashRecognition,
  voidInvoice,
  voidPayment,
} from '../src/index';
import { createWorld, dbErrorMessage, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let customerId: string;
let checkingId: string;
let savingsId: string;
let storage: LocalStorage;
let tmpDir: string;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  customerId = (await w.run(w.ctxA, (s) => createContact(s, { name: 'Acme Corp', isCustomer: true, isVendor: false }))).id;
  checkingId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Checking', kind: 'bank', ledgerAccountId: acct.get('1000')! }))).id;
  const savingsLedger = await w.run(w.ctxA, (s) => createAccount(s, { code: '1010', name: 'Savings', type: 'asset', role: 'bank' }));
  savingsId = (await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Savings', kind: 'bank', ledgerAccountId: savingsLedger.id }))).id;
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-deletion-'));
  storage = new LocalStorage(tmpDir);
});
afterAll(async () => {
  await w.destroy();
  await rm(tmpDir, { recursive: true, force: true });
});

/** Everything the books report: balances, cash recognition by day/account, posted entry count. */
async function books() {
  return w.run(w.ctxA, async (s) => {
    const balances = (await listAccounts(s, { withBalances: true })).map((a) => `${a.code}=${Number(a.balance).toFixed(2)}`).sort();
    const cash = await s.tx.execute<{ k: string }>(sql`select date::text || '|' || account_id || '|' || sum(amount)::numeric(20,2)::text as k from cash_recognitions group by date, account_id having sum(amount) <> 0 order by 1`);
    const entries = await s.tx.execute<{ n: string }>(sql`select count(*)::text as n from journal_entries where status = 'posted'`);
    return { balances, cash: cash.rows.map((r) => r.k), entries: Number(entries.rows[0]!.n) };
  });
}

async function issue(amount: string, issueDate = '2026-06-01') {
  const draft = await w.run(w.ctxA, (s) =>
    createDraftInvoice(s, { contactId: customerId, issueDate, lines: [{ description: 'Work', quantity: '1', unitPrice: amount, incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }),
  );
  return w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
}

async function issueCredit(amount: string, issueDate = '2026-06-05') {
  const draft = await w.run(w.ctxA, (s) => createDraftCreditNote(s, { contactId: customerId, issueDate, lines: [{ description: 'Credit', quantity: '1', unitPrice: amount, incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }));
  return w.run(w.ctxA, (s) => issueCreditNote(s, draft.id, { version: draft.version }));
}

const pay = (amount: string, allocations: { invoiceId: string; amount: string }[] = [], date = '2026-06-10') =>
  w.run(w.ctxA, (s) => createPayment(s, { contactId: customerId, date, amount, method: 'check', depositAccountId: acct.get('1000')!, allocations, isRefundableDeposit: false }));

const del = (type: Parameters<typeof deleteRecord>[1]['type'], id: string, version: number, reason = 'Entered by mistake') =>
  w.run(w.ctxA, (s) => deleteRecord(s, { type, id, version, reason }));

const cashOk = async () => expect((await w.run(w.ctxA, (s) => verifyCashRecognition(s))).diffs).toEqual([]);

describe('permanent deletion', () => {
  it('deletes an issued invoice and its entry as if it never existed, keeping an audit snapshot', async () => {
    const before = await books();
    const inv = await issue('500');
    const voided = await w.run(w.ctxA, (s) => voidInvoice(s, inv.id, { version: inv.version, reason: 'Wrong customer' }));
    const preview = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'invoice', id: inv.id }));
    expect(preview.canDelete).toBe(true);
    expect(preview.entries.map((e) => e.sourceType).sort()).toEqual(['invoice', 'invoice_void']);
    const res = await del('invoice', inv.id, voided.version);
    expect(res.entriesDeleted).toBe(2);
    expect(await books()).toEqual(before);
    await expect(w.run(w.ctxA, (s) => getInvoice(s, inv.id))).rejects.toMatchObject({ code: 'not_found' });
    const audit = await w.run(w.ctxA, (s) => listAudit(s, { limit: 5, entityType: 'invoice', entityId: inv.id }));
    const event = audit.items.find((a) => a.action === 'invoice.deleted')!;
    expect(event.reason).toBe('Entered by mistake');
    expect((event.details as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('blocks deleting an invoice with a payment applied and lists the payment', async () => {
    const inv = await issue('300');
    const p = await pay('100', [{ invoiceId: inv.id, amount: '100' }]);
    const fresh = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    const preview = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'invoice', id: inv.id }));
    expect(preview.canDelete).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({ code: 'applied_payment', record: expect.objectContaining({ type: 'payment', id: p.id }) })]);
    await expect(del('invoice', inv.id, fresh.version)).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('deleting a payment reopens the invoices it settled and recomputes cash recognition exactly', async () => {
    const inv = await issue('100.00');
    const before = await books();
    const p1 = await pay('33.33', [{ invoiceId: inv.id, amount: '33.33' }], '2026-06-10');
    const p2 = await pay('50', [], '2026-06-11');
    await w.run(w.ctxA, (s) => allocatePayment(s, p2.id, { version: p2.version, allocations: [{ invoiceId: inv.id, amount: '50' }], date: '2026-06-12' }));
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).balanceDue).toBe('16.67');
    const preview = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'payment', id: p1.id }));
    expect(preview.affectedDocuments).toEqual([expect.objectContaining({ type: 'invoice', id: inv.id })]);
    await del('payment', p1.id, p1.version);
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).balanceDue).toBe('50.00');
    await cashOk();
    // removing the other payment too returns the books to before either existed
    const p2now = await w.run(w.ctxA, (s) => getPayment(s, p2.id));
    await del('payment', p2.id, p2now.version);
    const after = await w.run(w.ctxA, (s) => getInvoice(s, inv.id));
    expect(after.status).toBe('issued');
    expect(after.balanceDue).toBe('100.00');
    expect(await books()).toEqual(before);
  });

  it('deletes a voided payment together with its void entry', async () => {
    const before = await books();
    const p = await pay('75');
    const v = await w.run(w.ctxA, (s) => voidPayment(s, p.id, { version: p.version, reason: 'Bounced' }));
    await del('payment', p.id, v.version);
    expect(await books()).toEqual(before);
  });

  it('a refund blocks its payment; deleting the refund restores the unapplied amount', async () => {
    const p = await pay('200');
    const r = await w.run(w.ctxA, (s) => createRefund(s, { sourceType: 'payment', sourceId: p.id, date: '2026-06-20', amount: '80', fromAccountId: acct.get('1000')!, method: 'check' }));
    const blocked = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'payment', id: p.id }));
    expect(blocked.blockers.map((b) => b.code)).toEqual(['refund']);
    await del('refund', r.id, 0);
    const after = await w.run(w.ctxA, (s) => getPayment(s, p.id));
    expect(after.unappliedAmount).toBe('200.00');
    expect(after.amountRefunded).toBe('0.00');
    await cashOk();
  });

  it('deleting an applied credit note reopens the invoice; its refunds block it', async () => {
    const inv = await issue('400');
    const before = await books();
    const cn = await issueCredit('150');
    await w.run(w.ctxA, (s) => applyCreditNote(s, cn.id, { version: cn.version, allocations: [{ invoiceId: inv.id, amount: '100' }] }));
    const r = await w.run(w.ctxA, (s) => createRefund(s, { sourceType: 'credit_note', sourceId: cn.id, date: '2026-06-21', amount: '50', fromAccountId: acct.get('1000')!, method: 'check' }));
    const blocked = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'credit_note', id: cn.id }));
    expect(blocked.blockers).toEqual([expect.objectContaining({ code: 'refund', record: expect.objectContaining({ id: r.id }) })]);
    await del('refund', r.id, 0);
    const cnNow = await w.run(w.ctxA, (s) => getCreditNote(s, cn.id));
    expect(cnNow.balance).toBe('50.00');
    await cashOk();
    await del('credit_note', cn.id, cnNow.version);
    expect((await w.run(w.ctxA, (s) => getInvoice(s, inv.id))).balanceDue).toBe('400.00');
    expect(await books()).toEqual(before);
  });

  it('deletes a manual journal with its reversal; document entries must be deleted through the document', async () => {
    const before = await books();
    const je = await w.run(w.ctxA, (s) =>
      createManualJournal(s, { date: '2026-06-03', memo: 'Owner draw', post: true, cashTreatment: 'exclude', lines: [{ accountId: acct.get('3100')!, debit: '25' }, { accountId: acct.get('1000')!, credit: '25' }] }),
    );
    const rev = await w.run(w.ctxA, (s) => reverseEntry(s, je.id, { date: '2026-06-04', reason: 'Wrong' }));
    // deleting the reversal removes the pair
    await del('journal_entry', rev.id, rev.version);
    expect(await books()).toEqual(before);

    const inv = await issue('10');
    const preview = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'journal_entry', id: inv.journalEntryId! }));
    expect(preview.blockers).toEqual([expect.objectContaining({ code: 'document_entry', record: expect.objectContaining({ type: 'invoice', id: inv.id }) })]);
  });

  it('deleting a reconciled purchase removes it from the completed reconciliation and reopens it', async () => {
    const line = await w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId: checkingId, date: '2026-07-02', amount: '-40', description: 'PRINTER INK' }));
    await w.run(w.ctxA, (s) => categorizeTransaction(s, line.id, { version: line.version, lines: [{ accountId: acct.get('5140')!, amount: '40', description: '' }] }));
    const txn = await w.run(w.ctxA, (s) => getBankTransaction(s, line.id));
    const ledger = (await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true }))).find((a) => a.code === '1000')!.balance!;
    const rec = await w.run(w.ctxA, (s) =>
      startReconciliation(s, { bankAccountId: checkingId, statementStartDate: '2026-01-01', statementEndDate: '2026-07-31', statementOpeningBalance: '0', statementClosingBalance: Number(ledger).toFixed(2) }),
    );
    const toggled = await w.run(w.ctxA, (s) => toggleReconciliationItems(s, rec.id, { version: rec.version, clear: rec.lines.map((l) => l.journalLineId), unclear: [] }));
    await w.run(w.ctxA, (s) => completeReconciliation(s, rec.id, { version: toggled.version }));

    const purchaseId = (await w.run(w.ctxA, (s) => s.tx.execute<{ id: string; version: number }>(sql`select id, version from purchases where bank_transaction_id = ${txn.id}`))).rows[0]!;
    const preview = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'purchase', id: purchaseId.id }));
    expect(preview.reconciliations).toEqual([expect.objectContaining({ id: rec.id, status: 'completed' })]);
    expect(preview.bankTransactions).toEqual([expect.objectContaining({ id: txn.id })]);
    const res = await del('purchase', purchaseId.id, purchaseId.version);
    expect(res.reconciliationsReopened).toBe(1);
    const detail = await w.run(w.ctxA, (s) => getReconciliation(s, rec.id));
    expect(detail.status).toBe('in_progress');
    expect(detail.lines.some((l) => l.entryId === txn.journalEntryId)).toBe(false);
    const back = await w.run(w.ctxA, (s) => getBankTransaction(s, txn.id));
    expect(back.status).toBe('unreviewed');
    expect(back.journalEntryId).toBeNull();
    await cashOk();
  });

  it('deleting a bank line removes its transfer, resets the other side, and keeps it out of later imports', async () => {
    const before = await books();
    const out = await w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId: checkingId, date: '2026-08-01', amount: '-500', description: 'TO SAVINGS' }));
    const into = await w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId: savingsId, date: '2026-08-01', amount: '500', description: 'FROM CHECKING' }));
    await w.run(w.ctxA, (s) => transferTransaction(s, out.id, { version: out.version, counterpartTransactionId: into.id }));
    const outNow = await w.run(w.ctxA, (s) => getBankTransaction(s, out.id));
    await del('bank_transaction', out.id, outNow.version);
    const other = await w.run(w.ctxA, (s) => getBankTransaction(s, into.id));
    expect(other.status).toBe('unreviewed');
    await expect(w.run(w.ctxA, (s) => getBankTransaction(s, out.id))).rejects.toMatchObject({ code: 'not_found' });
    const otherNow = await w.run(w.ctxA, (s) => getBankTransaction(s, into.id));
    await del('bank_transaction', into.id, otherNow.version);
    expect(await books()).toEqual(before);
  });

  it('remembers deleted CSV lines so re-importing the statement skips them', async () => {
    const csv = (rows: string[]) => `Date,Description,Amount\n${rows.join('\n')}\n`;
    const first = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: checkingId, fileName: 'sep.csv', content: csv(['09/01/2026,DUPLICATE CHARGE,-12.00']) }));
    await w.run(w.ctxA, (s) => commitBatch(s, first.id));
    const inbox = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId }));
    const dup = inbox.items.find((t) => t.description === 'DUPLICATE CHARGE')!;
    await del('bank_transaction', dup.id, dup.version);
    const again = await w.run(w.ctxA, (s) => previewCsv(s, storage, { bankAccountId: checkingId, fileName: 'sep-full.csv', content: csv(['09/01/2026,DUPLICATE CHARGE,-12.00', '09/02/2026,NEW CHARGE,-3.00']) }));
    expect(again.duplicateCount).toBe(1);
    expect(again.rows?.find((r) => r.description === 'DUPLICATE CHARGE')?.error).toMatch(/Deleted earlier/);
    const committed = await w.run(w.ctxA, (s) => commitBatch(s, again.id));
    expect(committed.importedCount).toBe(1);
    const after = await w.run(w.ctxA, (s) => listInbox(s, { limit: 50, bankAccountId: checkingId }));
    expect(after.items.filter((t) => t.description === 'DUPLICATE CHARGE')).toHaveLength(0);
  });

  it('resets a deposit line matched to a deleted payment', async () => {
    const p = await pay('60', [], '2026-08-05');
    const line = await w.run(w.ctxA, (s) => createManualBankTransaction(s, { bankAccountId: checkingId, date: '2026-08-05', amount: '60', description: 'DEPOSIT' }));
    await w.run(w.ctxA, (s) => matchTransaction(s, line.id, { version: line.version, targets: [{ targetType: 'payment', targetId: p.id }] }));
    await del('payment', p.id, p.version);
    const back = await w.run(w.ctxA, (s) => getBankTransaction(s, line.id));
    expect(back.status).toBe('unreviewed');
    const matches = await w.run(w.ctxA, (s) => s.tx.execute(sql`select 1 from transaction_matches where bank_transaction_id = ${line.id}`));
    expect(matches.rows).toHaveLength(0);
  });

  it('refuses deletes that touch a closed period', async () => {
    const inv = await issue('90', '2026-02-10');
    const period = await w.run(w.ctxA, (s) => closePeriod(s, { startDate: '2026-02-01', endDate: '2026-02-28', reason: 'Closed' }));
    const preview = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'invoice', id: inv.id }));
    expect(preview.lockedDates).toEqual(['2026-02-10']);
    expect(preview.canDelete).toBe(false);
    await expect(del('invoice', inv.id, inv.version)).rejects.toMatchObject({ code: 'period_locked' });
    await w.run(w.ctxA, (s) => reopenPeriod(s, period.id, { reason: 'Fix', version: period.version }));
    await del('invoice', inv.id, inv.version);
  });

  it('honours the company setting in the service and the database', async () => {
    const inv = await issue('20');
    const company = await w.run(w.ctxA, async (s) => s.company);
    await w.run(w.ctxA, (s) => updateCompany(s, { version: company.version, transactionDeletionEnabled: false }));
    const preview = await w.run(w.ctxA, (s) => previewDeletion(s, { type: 'invoice', id: inv.id }));
    expect(preview.blockers[0]?.code).toBe('disabled');
    await expect(del('invoice', inv.id, inv.version)).rejects.toMatchObject({ code: 'forbidden' });
    // even with the session flag set, the guard refuses while the company disallows it
    const err = await withCompany(w.tdb.app.db, w.ctxA, async (tx) => {
      await tx.execute(sql`select set_config('app.hard_delete', 'on', true)`);
      await tx.execute(sql`delete from journal_entries where id = ${inv.journalEntryId}`);
    }).catch((e: unknown) => e);
    expect(dbErrorMessage(err)).toMatch(/cannot be deleted/);
    const now = await w.run(w.ctxA, async (s) => s.company);
    await w.run(w.ctxA, (s) => updateCompany(s, { version: now.version, transactionDeletionEnabled: true }));
    // and without the flag, posted rows stay protected as before
    const err2 = await withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`delete from invoices where id = ${inv.id}`)).catch((e: unknown) => e);
    expect(dbErrorMessage(err2)).toMatch(/cannot be deleted/);
  });

  it('keeps cash reports right after a full recognition rebuild', async () => {
    const before = await books();
    const p = await pay('45', [], '2026-09-10');
    await w.run(w.ctxA, (s) => rebuildCashRecognition(s, 'test'));
    await del('payment', p.id, p.version);
    await cashOk();
    expect(await books()).toEqual(before);
  });

  it('is scoped to the company and replays idempotently', async () => {
    const inv = await issue('15');
    await expect(w.run(w.ctxB, (s) => deleteRecord(s, { type: 'invoice', id: inv.id, version: inv.version, reason: 'x' }))).rejects.toMatchObject({ code: 'not_found' });
    const input = { type: 'invoice' as const, id: inv.id, version: inv.version, reason: 'Duplicate', idempotencyKey: 'delete-key-0001' };
    const first = await w.run(w.ctxA, (s) => deleteRecord(s, input));
    const replay = await w.run(w.ctxA, (s) => deleteRecord(s, input));
    expect(replay).toEqual(first);
    await cashOk();
  });
});
