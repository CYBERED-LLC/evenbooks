import { describe, expect, it } from 'vitest';
import { groupLedgerRows, ledgerEntryFingerprint, unfoldSectionedLedger, type LedgerCsvMapping } from '../src/index';

const byId: LedgerCsvMapping = {
  date: 'Transaction Date',
  account: 'Account Name',
  description: 'Transaction Description',
  memo: 'Transaction Line Description',
  group: 'Transaction ID',
  amounts: { debit: 'Debit Amount (Two Column Approach)', credit: 'Credit Amount (Two Column Approach)' },
  dateOrder: 'YMD',
};

const row = (id: string, date: string, account: string, debit: string, credit: string, desc = '', line = '') => ({
  'Transaction ID': id,
  'Transaction Date': date,
  'Account Name': account,
  'Transaction Description': desc,
  'Transaction Line Description': line,
  'Debit Amount (Two Column Approach)': debit,
  'Credit Amount (Two Column Approach)': credit,
});

describe('groupLedgerRows by transaction id', () => {
  it('groups interleaved rows, keeps file order, and balances', () => {
    const entries = groupLedgerRows(
      [
        row('T1', '2025-01-05', 'Checking', '100.00', '', 'Client payment'),
        row('T2', '2025-01-06', 'Office Supplies', '25.50', '', 'Staples'),
        row('T1', '2025-01-05', 'Consulting Income', '', '100.00'),
        row('T2', '2025-01-06', 'Checking', '', '25.50', '', 'card'),
      ],
      byId,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: 'T1', date: '2025-01-05', description: 'Client payment', error: null, rowNos: [1, 3] });
    expect(entries[0]!.lines).toEqual([
      { rowNo: 1, account: 'Checking', debit: '100', credit: '0', memo: null },
      { rowNo: 3, account: 'Consulting Income', debit: '0', credit: '100', memo: null },
    ]);
    expect(entries[1]).toMatchObject({ key: 'T2', description: 'Staples', error: null });
    expect(entries[1]!.lines[1]!.memo).toBe('card');
  });

  it('reports unbalanced, single-line, mixed-date and unparseable transactions', () => {
    const entries = groupLedgerRows(
      [
        row('A', '2025-01-05', 'Checking', '100', ''),
        row('A', '2025-01-05', 'Income', '', '90'),
        row('B', '2025-01-05', 'Checking', '5', ''),
        row('C', '2025-01-05', 'Checking', '5', ''),
        row('C', '2025-01-06', 'Income', '', '5'),
        row('D', 'not a date', 'Checking', '5', ''),
        row('D', '2025-01-07', 'Income', '', '5'),
        row('', '2025-01-07', 'Income', '', '5'),
      ],
      byId,
    );
    expect(entries.map((e) => e.error)).toEqual([
      'Debits 100.00 do not equal credits 90.00',
      'Only one line; a transaction needs at least two',
      'Lines are dated 2025-01-05, 2025-01-06; a transaction must have one date',
      'Row 6: date: Unparseable date "not a date"',
      'Row 8: missing Transaction ID',
    ]);
  });

  it('drops zero-amount lines but keeps their row numbers', () => {
    const [e] = groupLedgerRows([row('A', '2025-01-05', 'Checking', '10', ''), row('A', '2025-01-05', 'Sales Tax', '0.00', ''), row('A', '2025-01-05', 'Income', '', '10')], byId);
    expect(e!.error).toBeNull();
    expect(e!.lines).toHaveLength(2);
    expect(e!.rowNos).toEqual([1, 2, 3]);
  });
});

describe('groupLedgerRows in file order', () => {
  const m: LedgerCsvMapping = { date: 'Date', account: 'Account', description: 'Description', amounts: { amount: 'Amount' }, dateOrder: 'MDY' };
  const r = (date: string, account: string, amount: string, description = '') => ({ Date: date, Account: account, Amount: amount, Description: description });

  it('closes a transaction when its lines balance', () => {
    const entries = groupLedgerRows(
      [r('01/05/2025', 'Checking', '100', 'Deposit'), r('01/05/2025', 'Income', '-60'), r('01/05/2025', 'Income', '-40'), r('01/05/2025', 'Rent', '500', 'Rent'), r('01/05/2025', 'Checking', '-500')],
      m,
    );
    expect(entries.map((e) => [e.key, e.lines.length, e.error])).toEqual([
      ['row:1', 3, null],
      ['row:4', 2, null],
    ]);
  });

  it('breaks on a date change and honours invert', () => {
    const entries = groupLedgerRows([r('01/05/2025', 'Checking', '-100'), r('01/06/2025', 'Income', '100'), r('01/06/2025', 'Checking', '-100')], {
      ...m,
      amounts: { amount: 'Amount', invert: true },
    });
    expect(entries[0]!.error).toBe('Only one line; a transaction needs at least two');
    expect(entries[1]).toMatchObject({ error: null, date: '2025-01-06' });
    expect(entries[1]!.lines[0]).toMatchObject({ account: 'Income', debit: '0', credit: '100' });
  });

  it('flags a trailing unbalanced transaction', () => {
    const entries = groupLedgerRows([r('01/05/2025', 'Checking', '100'), r('01/05/2025', 'Income', '-99')], m);
    expect(entries[0]!.error).toBe('Debits 100.00 do not equal credits 99.00');
  });
});

describe('ledgerEntryFingerprint', () => {
  it('ignores line order and account case, separates sequences', () => {
    const a = { date: '2025-01-05', lines: [{ rowNo: 1, account: 'Checking', debit: '10', credit: '0', memo: null }, { rowNo: 2, account: 'Income', debit: '0', credit: '10.00', memo: 'x' }] };
    const b = { date: '2025-01-05', lines: [{ rowNo: 9, account: 'income', debit: '0', credit: '10', memo: null }, { rowNo: 8, account: 'checking', debit: '10.000', credit: '0', memo: null }] };
    expect(ledgerEntryFingerprint(a, 0)).toBe(ledgerEntryFingerprint(b, 0));
    expect(ledgerEntryFingerprint(a, 0)).not.toBe(ledgerEntryFingerprint(a, 1));
  });
});

// Wave's "Account Transactions (General Ledger)" report: one section per account.
const GL_HEADERS = ['ACCOUNT NUMBER', 'DATE', 'DESCRIPTION', 'DEBIT (In Business Currency)', 'CREDIT (In Business Currency)', 'BALANCE (In Business Currency)'];
const gl = (cells: string[]) => Object.fromEntries(GL_HEADERS.map((h, i) => [h, cells[i] ?? '']));
const GL_ROWS = [
  gl(['', 'Wave Payments', '', '', '', '']),
  gl(['Starting Balance', '', '', '', '', '$0.00']),
  gl(['', '2026-01-03', 'Acme - Payment for Invoice #39', '$28.38', '', '$28.38']),
  gl(['Totals and Ending Balance', '', '', '$28.38', '$0.00', '$28.38']),
  gl(['Balance Change', '', '', '$28.38', '', '']),
  gl(['', '', '', '', '', '']),
  gl(['', 'Accounts Receivable', '', '', '', '']),
  gl(['Starting Balance', '', '', '', '', '$80.00']),
  gl(['', '2026-01-03', 'Acme - 39', '$30.00', '', '$110.00']),
  gl(['', '2026-01-03', 'Acme - Payment for Invoice #39', '', '$30.00', '$80.00']),
  gl(['', '2026-09-16', 'Acme - 44', '$161.02', '', '$241.02']),
  gl(['Totals and Ending Balance', '', '', '$191.02', '$30.00', '$241.02']),
  gl(['Balance Change', '', '', '$161.02', '', '']),
  gl(['', 'Sales', '', '', '', '']),
  gl(['Starting Balance', '', '', '', '', '"$22,981.49"']),
  gl(['', '2026-01-03', 'Acme - 39 - Google Workspace - Business Starter', '', '$30.00', '$23,011.49']),
  gl(['', '2026-09-16', 'Acme - 44 - Metered Hosting', '', '$15.00', '$23,026.49']),
  gl(['', '2026-09-16', 'Acme - 44 - Metered Hosting', '', '$146.02', '$23,172.51']),
  gl(['Totals and Ending Balance', '', '', '$0.00', '$191.02', '$23,172.51']),
  gl(['', 'Merchant Account Fees', '', '', '', '']),
  gl(['', '2026-01-03', 'Acme - Payment for Invoice #39', '$1.62', '', '$44.66']),
  gl(['Totals and Ending Balance', '', '', '$1.62', '$0.00', '$44.66']),
];

describe('unfoldSectionedLedger', () => {
  it('flattens a per-account report into rows with an Account column', () => {
    const out = unfoldSectionedLedger(GL_HEADERS, GL_ROWS)!;
    expect(out.headers[0]).toBe('Account');
    expect(out.records.map((r) => [r.Account, r.DATE, r['DEBIT (In Business Currency)'] || r['CREDIT (In Business Currency)']])).toEqual([
      ['Wave Payments', '2026-01-03', '$28.38'],
      ['Accounts Receivable', '2026-01-03', '$30.00'],
      ['Accounts Receivable', '2026-01-03', '$30.00'],
      ['Accounts Receivable', '2026-09-16', '$161.02'],
      ['Sales', '2026-01-03', '$30.00'],
      ['Sales', '2026-09-16', '$15.00'],
      ['Sales', '2026-09-16', '$146.02'],
      ['Merchant Account Fees', '2026-01-03', '$1.62'],
    ]);
  });

  it('leaves an ordinary table alone', () => {
    expect(unfoldSectionedLedger(['Date', 'Account', 'Amount'], [{ Date: '2025-01-01', Account: 'Cash', Amount: '1' }])).toBeNull();
    expect(unfoldSectionedLedger(['Transaction Date', 'Account Name', 'Debit'], [{ 'Transaction Date': '2025-01-01', 'Account Name': 'Cash', Debit: '1' }])).toBeNull();
  });
});

describe('groupLedgerRows by date and description', () => {
  const m: LedgerCsvMapping = {
    date: 'DATE',
    account: 'Account',
    description: 'DESCRIPTION',
    group: null,
    grouping: 'date-description',
    amounts: { debit: 'DEBIT (In Business Currency)', credit: 'CREDIT (In Business Currency)' },
    dateOrder: 'YMD',
  };

  it('pairs scattered lines and merges sales lines whose description extends the receivable line', () => {
    const entries = groupLedgerRows(unfoldSectionedLedger(GL_HEADERS, GL_ROWS)!.records, m);
    expect(entries.map((e) => [e.description, e.error, e.lines.length])).toEqual([
      ['Acme - Payment for Invoice #39', null, 3],
      ['Acme - 39', null, 2],
      ['Acme - 44', null, 3],
    ]);
    const invoice = entries[1]!;
    expect(invoice.lines).toEqual([
      { rowNo: 2, account: 'Accounts Receivable', debit: '30', credit: '0', memo: null },
      { rowNo: 5, account: 'Sales', debit: '0', credit: '30', memo: 'Acme - 39 - Google Workspace - Business Starter' },
    ]);
    expect(entries[2]!.lines.map((l) => l.account)).toEqual(['Accounts Receivable', 'Sales', 'Sales']);
  });

  it('merges the leftover unbalanced groups of a day when they net to zero, else reports each', () => {
    const rows = [
      { DATE: '2025-02-01', Account: 'Checking', DESCRIPTION: 'Deposit', Debit: '100', Credit: '' },
      { DATE: '2025-02-01', Account: 'Sales', DESCRIPTION: 'Widget sale', Debit: '', Credit: '100' },
      { DATE: '2025-02-02', Account: 'Checking', DESCRIPTION: 'Rent', Debit: '', Credit: '900' },
      { DATE: '2025-02-02', Account: 'Rent', DESCRIPTION: 'Office', Debit: '850', Credit: '' },
    ];
    const entries = groupLedgerRows(rows, { ...m, amounts: { debit: 'Debit', credit: 'Credit' } });
    expect(entries.map((e) => [e.description, e.error])).toEqual([
      ['Deposit; Widget sale', null],
      ['Rent', 'Only one line; a transaction needs at least two'],
      ['Office', 'Only one line; a transaction needs at least two'],
    ]);
  });

  it('does not treat "Acme - 4" as a prefix of "Acme - 44 - Hosting"', () => {
    const rows = [
      { DATE: '2025-02-01', Account: 'AR', DESCRIPTION: 'Acme - 4', Debit: '10', Credit: '' },
      { DATE: '2025-02-01', Account: 'Sales', DESCRIPTION: 'Acme - 44 - Hosting', Debit: '', Credit: '10' },
    ];
    const entries = groupLedgerRows(rows, { ...m, amounts: { debit: 'Debit', credit: 'Credit' } });
    // No prefix match, but the day's leftovers net to zero, so they combine into one entry.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.description).toBe('Acme - 4; Acme - 44 - Hosting');
  });
});
