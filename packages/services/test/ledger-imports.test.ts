import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalStorage } from '@evenbooks/integrations';
import {
  closePeriod,
  commitLedgerImport,
  createAccount,
  createLedgerImport,
  detectLedgerMapping,
  discardLedgerImport,
  getLedgerImport,
  listAccounts,
  listEntries,
  listLedgerImports,
  profitAndLoss,
  recognizeLedgerFormat,
  reverseEntry,
  updateLedgerImport,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;
let storage: LocalStorage;
let tmpDir: string;

// Shaped like Wave's "Export accounting transactions" CSV (subset of its columns).
const HEAD = 'Transaction ID,Transaction Date,Account Name,Transaction Description,Transaction Line Description,Amount (One column),Debit Amount (Two Column Approach),Credit Amount (Two Column Approach),Other Accounts for this Transaction,Customer,Vendor,Transaction Date Added';
const line = (id: string, date: string, account: string, desc: string, debit: string, credit: string, lineDesc = '') =>
  [id, date, account, desc, lineDesc, debit ? debit : `-${credit}`, debit, credit, '', '', '', '2025-03-01'].join(',');
const WAVE = [
  HEAD,
  line('W1', '2025-01-03', 'Cash on Hand', 'Client payment', '1200.00', ''),
  line('W1', '2025-01-03', 'Consulting Income', 'Client payment', '', '1200.00'),
  line('W2', '2025-01-10', 'Office Supplies', 'Staples', '45.10', ''),
  line('W2', '2025-01-10', 'Cash on Hand', 'Staples', '', '45.10', 'paper'),
  line('W3', '2025-01-15', 'Accounts Receivable', 'Invoice 12', '500.00', ''),
  line('W3', '2025-01-15', 'Consulting Income', 'Invoice 12', '', '500.00'),
  line('W4', '2025-01-20', 'Office Supplies', 'Broken', '10.00', ''),
  line('W4', '2025-01-20', 'Cash on Hand', 'Broken', '', '9.00'),
  line('W5', '2025-01-10', 'Office Supplies', 'Staples', '45.10', ''),
  line('W5', '2025-01-10', 'Cash on Hand', 'Staples', '', '45.10'),
].join('\n');

// Wave's "Account Transactions (General Ledger)" report as exported: BOM, CRLF, one section per account, currency symbols.
const WAVE_GL =
  '\ufeff' +
  [
    'ACCOUNT NUMBER,DATE,DESCRIPTION,DEBIT (In Business Currency),CREDIT (In Business Currency),BALANCE (In Business Currency)',
    ',Wave Payments,,,,',
    'Starting Balance,,,,,$0.00',
    ',2026-01-03,Acme - Payment for Invoice #39,$28.38,,$28.38',
    'Totals and Ending Balance,,,$28.38,$0.00,$28.38',
    'Balance Change,,,$28.38,,',
    '""',
    ',Accounts Receivable,,,,',
    'Starting Balance,,,,,$80.00',
    ',2026-01-03,Acme - 39,$30.00,,$110.00',
    ',2026-01-03,Acme - Payment for Invoice #39,,$30.00,$80.00',
    ',2026-09-16,Acme - 44,"$1,161.02",,"$1,241.02"',
    'Totals and Ending Balance,,,"$1,191.02",$30.00,"$1,241.02"',
    '""',
    ',Sales,,,,',
    'Starting Balance,,,,,"$22,981.49"',
    ',2026-01-03,Acme - 39 - Google Workspace - Business Starter,,$30.00,"$23,011.49"',
    ',2026-09-16,Acme - 44 - Metered Hosting,,$15.00,"$23,026.49"',
    ',2026-09-16,Acme - 44 - Metered Hosting,,"$1,146.02","$24,172.51"',
    'Totals and Ending Balance,,,$0.00,"$1,191.02","$24,172.51"',
    '""',
    ',Merchant Account Fees,,,,',
    'Starting Balance,,,,,$43.04',
    ',2026-01-03,Acme - Payment for Invoice #39,$1.62,,$44.66',
    'Totals and Ending Balance,,,$1.62,$0.00,$44.66',
  ].join('\r\n');

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'evenbooks-storage-'));
  storage = new LocalStorage(tmpDir);
});
afterAll(async () => {
  await w.destroy();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('detectLedgerMapping', () => {
  it('recognizes Wave columns and prefers debit/credit columns', () => {
    const m = detectLedgerMapping(HEAD.split(','));
    expect(m).toMatchObject({
      date: 'Transaction Date',
      account: 'Account Name',
      description: 'Transaction Description',
      memo: 'Transaction Line Description',
      group: 'Transaction ID',
      amounts: { debit: 'Debit Amount (Two Column Approach)', credit: 'Credit Amount (Two Column Approach)' },
    });
  });
  it('recognizes a plain journal export and guesses day-first dates', () => {
    const m = detectLedgerMapping(['Date', 'Journal No.', 'Account', 'Description', 'Debit', 'Credit'], [{ Date: '25/01/2025' }]);
    expect(m).toMatchObject({ group: 'Journal No.', account: 'Account', amounts: { debit: 'Debit', credit: 'Credit' }, dateOrder: 'DMY' });
    expect(detectLedgerMapping(['Date', 'Description', 'Amount'])).toBeNull();
  });
  it('names the Wave export it recognized, and nothing for other files', () => {
    expect(recognizeLedgerFormat(HEAD.split(','))).toBe('wave_transactions');
    expect(recognizeLedgerFormat(['Account', 'ACCOUNT NUMBER', 'DATE', 'DESCRIPTION', 'DEBIT (In Business Currency)', 'CREDIT (In Business Currency)'])).toBe('wave_ledger');
    expect(recognizeLedgerFormat(['Date', 'Journal No.', 'Account', 'Description', 'Debit', 'Credit'])).toBeNull();
  });
});

describe('ledger history import', () => {
  let importId: string;
  let receivablesId: string;

  it('previews: groups by transaction, flags unbalanced, auto-maps nothing it cannot match', async () => {
    const p = await w.run(w.ctxA, (s) => createLedgerImport(s, storage, { fileName: 'wave.csv', content: WAVE }));
    importId = p.id;
    expect(p.recognizedFormat).toBe('wave_transactions');
    expect(p).toMatchObject({ status: 'previewed', rowCount: 10, entryCount: 5, readyCount: 4, errorCount: 1, duplicateCount: 0, windowStart: '2025-01-03', windowEnd: '2025-01-20' });
    expect(p.entries!.find((e) => e.key === 'W4')).toMatchObject({ status: 'error', error: 'Debits 10.00 do not equal credits 9.00' });
    expect(p.accounts!.map((a) => a.source)).toEqual(['Accounts Receivable', 'Cash on Hand', 'Consulting Income', 'Office Supplies']);
    // "Accounts Receivable" does not match "Accounts Receivable (Evenbooks invoices)", which only documents may use anyway.
    const ar = p.accounts!.find((a) => a.source === 'Accounts Receivable')!;
    expect(ar.accountId).toBeNull();
    expect(ar.problem).toBeNull();
    expect(p.accounts!.find((a) => a.source === 'Cash on Hand')!.accountId).toBeNull();
  });

  it('refuses the built-in receivable account when it is chosen explicitly', async () => {
    const p = await w.run(w.ctxA, (s) => updateLedgerImport(s, storage, importId, { accountMap: { 'Accounts Receivable': acct.get('1100')! } }));
    const ar = p.accounts!.find((a) => a.source === 'Accounts Receivable')!;
    expect(ar.accountId).toBe(acct.get('1100'));
    expect(ar.problem).toMatch(/only holds invoices, payments and credit notes made in Evenbooks/);
  });

  it('refuses to commit while accounts are unmapped or unusable', async () => {
    await expect(w.run(w.ctxA, (s) => commitLedgerImport(s, storage, importId))).rejects.toMatchObject({ code: 'validation', message: /Map every account/ });
  });

  it('maps accounts, commits ready entries in date order, and skips the broken one', async () => {
    const receivables = await w.run(w.ctxA, (s) => createAccount(s, { code: '1190', name: 'Receivables from Wave', type: 'asset' }));
    receivablesId = receivables.id;
    const p = await w.run(w.ctxA, (s) =>
      updateLedgerImport(s, storage, importId, {
        accountMap: { 'Cash on Hand': acct.get('1000')!, 'Consulting Income': acct.get('4100')!, 'Office Supplies': acct.get('5110')!, 'Accounts Receivable': receivablesId },
      }),
    );
    expect(p.accounts!.every((a) => a.accountId && !a.problem)).toBe(true);
    const done = await w.run(w.ctxA, (s) => commitLedgerImport(s, storage, importId, 'ledger-import-test-1'));
    expect(done).toMatchObject({ status: 'committed', importedCount: 4, errorCount: 1 });
    // Idempotent replay returns the same result.
    expect(await w.run(w.ctxA, (s) => commitLedgerImport(s, storage, importId, 'ledger-import-test-1'))).toMatchObject({ status: 'committed', importedCount: 4 });

    const { items } = await w.run(w.ctxA, (s) => listEntries(s, { limit: 50 } as never));
    const imported = items.filter((e) => e.sourceType === 'import').sort((a, b) => a.entryNumber! - b.entryNumber!);
    expect(imported.map((e) => [e.date, e.memo, e.cashTreatment])).toEqual([
      ['2025-01-03', 'Client payment', 'include'],
      ['2025-01-10', 'Staples', 'include'],
      ['2025-01-10', 'Staples', 'include'],
      ['2025-01-15', 'Invoice 12', 'exclude'],
    ]);
    const balances = await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true }));
    const bal = (code: string) => Number(balances.find((a) => a.code === code)!.balance).toFixed(2);
    expect(bal('1000')).toBe('1109.80');
    expect(bal('1190')).toBe('500.00');
    expect(bal('4100')).toBe('1700.00');

    // Accrual sees the invoice; cash sees only entries that moved money.
    const accrual = await w.run(w.ctxA, (s) => profitAndLoss(s, { from: '2025-01-01', to: '2025-01-31', basis: 'accrual' }));
    const cash = await w.run(w.ctxA, (s) => profitAndLoss(s, { from: '2025-01-01', to: '2025-01-31', basis: 'cash' }));
    expect(Number(accrual.netIncome).toFixed(2)).toBe('1609.80');
    expect(Number(cash.netIncome).toFixed(2)).toBe('1109.80');
  });

  it('flags the same file as already committed and an overlapping export as duplicates', async () => {
    const again = await w.run(w.ctxA, (s) => createLedgerImport(s, storage, { fileName: 'wave-again.csv', content: WAVE }));
    expect(again).toMatchObject({ alreadyCommitted: true, readyCount: 0, duplicateCount: 4 });
    await expect(w.run(w.ctxA, (s) => commitLedgerImport(s, storage, again.id))).rejects.toMatchObject({ code: 'duplicate' });

    // A later export repeats January and adds February: only February is new.
    const later = WAVE + '\n' + [line('W9', '2025-02-01', 'Office Supplies', 'Ink', '20.00', ''), line('W9', '2025-02-01', 'Cash on Hand', 'Ink', '', '20.00')].join('\n');
    const p = await w.run(w.ctxA, (s) => createLedgerImport(s, storage, { fileName: 'wave-feb.csv', content: later }));
    expect(p).toMatchObject({ alreadyCommitted: false, readyCount: 1, duplicateCount: 4, errorCount: 1 });
    // Account choices are remembered per import, so the automatic matches need repeating here.
    expect(p.accounts!.find((a) => a.source === 'Office Supplies')!.accountId).toBeNull();
    await w.run(w.ctxA, (s) => discardLedgerImport(s, p.id));
    await w.run(w.ctxA, (s) => discardLedgerImport(s, again.id));
    const list = await w.run(w.ctxA, (s) => listLedgerImports(s));
    expect(list.map((x) => x.status)).toEqual(['discarded', 'discarded', 'committed']);
  });

  it('marks entries in a closed period as errors and lets imported entries be reversed', async () => {
    await w.run(w.ctxA, (s) => closePeriod(s, { startDate: '2025-02-01', endDate: '2025-02-28' }));
    const content = [HEAD, line('X1', '2025-02-03', 'Checking Account', 'Feb', '5.00', ''), line('X1', '2025-02-03', 'Supplies', 'Feb', '', '5.00')].join('\n');
    const p = await w.run(w.ctxA, (s) => createLedgerImport(s, storage, { fileName: 'feb.csv', content }));
    expect(p.entries![0]).toMatchObject({ status: 'error', error: 'Feb 3, 2025 is in a locked period. Reopen it in Settings → Accounting periods, or use a later date.' });
    // Chart names auto-match.
    expect(p.accounts!.map((a) => a.accountId)).toEqual([acct.get('1000'), acct.get('5110')]);

    const { items } = await w.run(w.ctxA, (s) => listEntries(s, { limit: 50 } as never));
    const first = items.find((e) => e.sourceType === 'import' && e.memo === 'Client payment')!;
    const rev = await w.run(w.ctxA, (s) => reverseEntry(s, first.id, { date: '2025-03-01', reason: 'Imported twice' }));
    expect(rev.sourceType).toBe('reversal');
  });

  it("reads Wave's per-account General Ledger report as exported and groups its lines by date and description", async () => {
    const d = await w.run(w.ctxA, (s) => createLedgerImport(s, storage, { fileName: 'Acme Account Transactions.csv', content: WAVE_GL }));
    expect(d.mapping).toMatchObject({ account: 'Account', date: 'DATE', description: 'DESCRIPTION', group: null, grouping: 'date-description' });
    expect(d.headers?.[0]).toBe('Account');
    expect(d.recognizedFormat).toBe('wave_ledger');
    expect([d.rowCount, d.entryCount, d.readyCount, d.errorCount]).toEqual([8, 3, 3, 0]);
    expect(d.entries!.map((e) => [e.date, e.description, e.lines.map((l) => `${l.account} ${l.debit}/${l.credit}`)])).toEqual([
      ['2026-01-03', 'Acme - Payment for Invoice #39', ['Wave Payments 28.38/0', 'Accounts Receivable 0/30', 'Merchant Account Fees 1.62/0']],
      ['2026-01-03', 'Acme - 39', ['Accounts Receivable 30/0', 'Sales 0/30']],
      ['2026-09-16', 'Acme - 44', ['Accounts Receivable 1161.02/0', 'Sales 0/15', 'Sales 0/1146.02']],
    ]);
    expect(d.accounts!.map((a) => a.source)).toEqual(['Accounts Receivable', 'Merchant Account Fees', 'Sales', 'Wave Payments']);
    // Switching to file-order grouping on this layout breaks every transaction, and the choice is reversible.
    const seq = await w.run(w.ctxA, (s) => updateLedgerImport(s, storage, d.id, { mapping: { ...d.mapping!, grouping: 'sequence' } }));
    expect(seq.readyCount).toBe(0);
    const back = await w.run(w.ctxA, (s) => updateLedgerImport(s, storage, d.id, { mapping: d.mapping! }));
    expect(back.readyCount).toBe(3);
    await w.run(w.ctxA, (s) => discardLedgerImport(s, d.id));
  });

  it('keeps imports private to their company', async () => {
    await expect(w.run(w.ctxB, (s) => getLedgerImport(s, storage, importId))).rejects.toMatchObject({ code: 'not_found' });
  });
});
