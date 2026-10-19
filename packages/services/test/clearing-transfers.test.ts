import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@evenbooks/db';
import type { AccountRole } from '@evenbooks/contracts';
import {
  bulkReview, createBankAccount, createManualBankTransaction, createManualJournal,
  getBankTransaction, getEntry, listAccounts, transferTransaction, undoReview,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
let accounts: Map<string, string>;
let bankId: string;

beforeAll(async () => {
  w = await createWorld();
  accounts = await w.accountsByCode(w.ctxA);
  bankId = (await w.run(w.ctxA, (s) => createBankAccount(s, {
    name: 'Mercury Checking', kind: 'bank', ledgerAccountId: accounts.get('1000')!,
  }))).id;
});
afterAll(async () => { await w.destroy(); });

const balances = async () => (await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true })))
  .map((a) => ({ ...a, balance: Number(a.balance).toFixed(2) }));
const deposit = () => w.run(w.ctxA, (s) => createManualBankTransaction(s, {
  bankAccountId: bankId, date: '2026-09-29', amount: '28.38', description: 'Wave Financia',
}));

describe('clearing account payouts', () => {
  it('records three payouts separately, reports a stale item, retries safely and undoes only successful transfers', async () => {
    const transactions = await Promise.all([deposit(), deposit(), deposit(), deposit()]);
    const before = await balances();
    const input = {
      action: 'transfer' as const,
      otherLedgerAccountId: accounts.get('1050')!,
      items: transactions.map((t, i) => ({ id: t.id, version: t.version + (i === 3 ? 1 : 0) })),
      idempotencyKey: 'bulk-clearing-payouts',
    };
    const r = await w.run(w.ctxA, (s) => bulkReview(s, input));
    expect(r).toMatchObject({ succeeded: 3, failed: 1 });
    const done = r.results.filter((x) => x.ok).map((x) => x.transaction!);
    expect(done.every((t) => t.status === 'transfer')).toBe(true);
    expect(new Set(done.map((t) => t.journalEntryId)).size).toBe(3);
    expect(r.results[3]).toMatchObject({ ok: false, error: { code: 'version_conflict' } });
    const after = await balances();
    expect(Number(after.find((a) => a.code === '1000')!.balance) - Number(before.find((a) => a.code === '1000')!.balance)).toBeCloseTo(85.14);
    expect(Number(after.find((a) => a.code === '1050')!.balance) - Number(before.find((a) => a.code === '1050')!.balance)).toBeCloseTo(-85.14);
    expect(after.filter((a) => a.type === 'income' || a.type === 'expense')).toEqual(before.filter((a) => a.type === 'income' || a.type === 'expense'));
    expect(await w.run(w.ctxA, (s) => bulkReview(s, input))).toEqual(r);
    expect(await balances()).toEqual(after);
    const undone = await w.run(w.ctxA, (s) => bulkReview(s, {
      action: 'undo', items: done.map((t) => ({ id: t.id, version: t.version })),
    }));
    expect(undone.succeeded).toBe(3);
    expect(await balances()).toEqual(before);
  });

  it('supports money in and money out without netting them into a single posting', async () => {
    const incoming = await deposit();
    const outgoing = await w.run(w.ctxA, (s) => createManualBankTransaction(s, {
      bankAccountId: bankId, date: '2026-09-29', amount: '-10.00', description: 'Funds to clearing',
    }));
    const r = await w.run(w.ctxA, (s) => bulkReview(s, {
      action: 'transfer', otherLedgerAccountId: accounts.get('1050')!,
      items: [incoming, outgoing].map((t) => ({ id: t.id, version: t.version })),
    }));
    expect(r.succeeded).toBe(2);
    const entry = await w.run(w.ctxA, (s) => getEntry(s, r.results[1]!.transaction!.journalEntryId!));
    expect(entry.lines).toEqual([
      expect.objectContaining({ accountId: accounts.get('1050'), debit: '10.00', credit: '0.00' }),
      expect.objectContaining({ accountId: accounts.get('1000'), debit: '0.00', credit: '10.00' }),
    ]);
    await w.run(w.ctxA, (s) => bulkReview(s, { action: 'undo', items: r.results.map((x) => ({ id: x.id, version: x.transaction!.version })) }));
  });

  it('leaves possible imported counterparts for individual review instead of posting them twice', async () => {
    const otherBank = await w.run(w.ctxA, (s) => createBankAccount(s, { name: 'Savings', kind: 'bank', newLedgerAccount: { code: '1070', name: 'Savings' } }));
    const incoming = await deposit();
    const other = await w.run(w.ctxA, (s) => createManualBankTransaction(s, {
      bankAccountId: otherBank.id, date: '2026-09-29', amount: '-28.38', description: 'Transfer to Mercury',
    }));
    const before = await balances();
    const r = await w.run(w.ctxA, (s) => bulkReview(s, {
      action: 'transfer', otherLedgerAccountId: otherBank.ledgerAccountId,
      items: [{ id: incoming.id, version: incoming.version }],
    }));
    expect(r).toMatchObject({ succeeded: 0, failed: 1 });
    expect(r.results[0]).toMatchObject({ error: { code: 'validation', message: expect.stringContaining('individually') } });
    expect(await balances()).toEqual(before);
    for (const t of [incoming, other]) expect(await w.run(w.ctxA, (s) => getBankTransaction(s, t.id))).toMatchObject({ status: 'unreviewed', journalEntryId: null });
  });

  it.each<{ code: string; role: AccountRole | null }>([
    { code: '1060', role: null },
    { code: '1061', role: 'processor_clearing' },
    { code: '1050', role: 'undeposited_funds' },
  ])('clears $role on deposit, excludes profit and loss, and supports undo', async ({ code, role }) => {
    const clearingId = role === 'undeposited_funds' ? accounts.get(code)! : await w.run(w.ctxA, async (s) => {
      const [row] = await s.tx.insert(schema.accounts).values({
        companyId: s.ctx.companyId, code, name: 'Wave Clearing', type: 'asset', role, currency: 'USD',
      }).returning();
      return row!.id;
    });
    await w.run(w.ctxA, (s) => createManualJournal(s, {
      date: '2026-09-28', memo: 'Money held before payout', cashTreatment: 'exclude', post: true,
      lines: [
        { accountId: clearingId, debit: '28.38', credit: '0' },
        { accountId: accounts.get('3000')!, debit: '0', credit: '28.38' },
      ],
    }));
    const before = await balances();
    const txn = await deposit();
    const input = { version: txn.version, otherLedgerAccountId: clearingId, idempotencyKey: `payout-${code}` };
    const done = await w.run(w.ctxA, (s) => transferTransaction(s, txn.id, input));
    expect(done.status).toBe('transfer');
    const entry = await w.run(w.ctxA, (s) => getEntry(s, done.journalEntryId!));
    expect(entry).toMatchObject({ sourceType: 'transfer', cashTreatment: 'exclude', totalDebit: '28.38', totalCredit: '28.38' });
    expect(entry.lines).toEqual([
      expect.objectContaining({ accountId: accounts.get('1000'), debit: '28.38', credit: '0.00' }),
      expect.objectContaining({ accountId: clearingId, debit: '0.00', credit: '28.38' }),
    ]);
    const after = await balances();
    expect(Number(after.find((a) => a.id === clearingId)!.balance)).toBe(0);
    expect(Number(after.find((a) => a.code === '1000')!.balance)).toBe(Number(before.find((a) => a.code === '1000')!.balance) + 28.38);
    expect(after.filter((a) => a.type === 'income' || a.type === 'expense')).toEqual(before.filter((a) => a.type === 'income' || a.type === 'expense'));
    // Retrying the same review must not post the payout twice.
    expect(await w.run(w.ctxA, (s) => transferTransaction(s, txn.id, input))).toEqual(done);
    expect(await balances()).toEqual(after);
    const undone = await w.run(w.ctxA, (s) => undoReview(s, txn.id, { version: done.version }));
    expect(undone.status).toBe('unreviewed');
    expect(await balances()).toEqual(before);
  });

  it.each(['1100', '2100', '2200', '4100', '5110', '1000'])('rejects control, income, expense and own accounts (%s) without posting', async (code) => {
    const txn = await deposit();
    const before = await balances();
    await expect(w.run(w.ctxA, (s) => transferTransaction(s, txn.id, {
      version: txn.version, otherLedgerAccountId: accounts.get(code)!,
    }))).rejects.toMatchObject({ code: 'validation' });
    expect(await w.run(w.ctxA, (s) => getBankTransaction(s, txn.id))).toMatchObject({ status: 'unreviewed', journalEntryId: null });
    expect(await balances()).toEqual(before);
  });
});
