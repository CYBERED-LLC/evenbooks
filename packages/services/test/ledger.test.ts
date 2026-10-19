import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withCompany } from '@evenbooks/db';
import {
  ServiceError,
  closePeriod,
  createManualJournal,
  getEntry,
  listAccounts,
  listAudit,
  listEntries,
  listPeriods,
  postDraftJournal,
  postOpeningBalances,
  reopenPeriod,
  reverseEntry,
  updateAccount,
  updateDraftJournal,
} from '../src/index';
import { createWorld, dbErrorMessage, type TestWorld } from './helpers';

let w: TestWorld;
let acct: Map<string, string>;

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
});
afterAll(async () => {
  await w.destroy();
});

const line = (code: string, side: 'debit' | 'credit', amount: string) => ({ accountId: acct.get(code)!, [side]: amount });

describe('company provisioning', () => {
  it('creates the default chart with system roles', async () => {
    const accounts = await w.run(w.ctxA, (s) => listAccounts(s));
    expect(accounts.length).toBeGreaterThan(30);
    const roles = accounts.filter((a) => a.role).map((a) => a.role);
    expect(roles).toContain('accounts_receivable');
    expect(roles).toContain('customer_deposits');
    expect(roles).toContain('sales_tax_payable');
    expect(accounts.find((a) => a.role === 'accounts_receivable')!.isSystem).toBe(true);
  });
});

describe('posting', () => {
  it('posts a balanced manual entry with sequential numbers and audit', async () => {
    const e1 = await w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date: '2026-01-15',
        memo: 'Owner funds the business',
        cashTreatment: 'exclude',
        post: true,
        lines: [line('1000', 'debit', '5000'), line('3000', 'credit', '5000')],
      }),
    );
    expect(e1.status).toBe('posted');
    expect(e1.entryNumber).toBe(1);
    expect(e1.totalDebit).toBe('5000.00');
    expect(e1.totalCredit).toBe('5000.00');
    const e2 = await w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date: '2026-01-16',
        memo: 'Paid rent by check',
        cashTreatment: 'include',
        post: true,
        lines: [line('5090', 'debit', '1200'), line('1000', 'credit', '1200')],
      }),
    );
    expect(e2.entryNumber).toBe(2);
    const audit = await w.run(w.ctxA, (s) => listAudit(s, { limit: 10 }));
    expect(audit.items.map((a) => a.action)).toContain('journal.posted');

    const balances = await w.run(w.ctxA, (s) => listAccounts(s, { withBalances: true }));
    expect(balances.find((a) => a.code === '1000')!.balance).toBe('3800.000000');
    expect(balances.find((a) => a.code === '5090')!.balance).toBe('1200.000000');
  });

  it('cash recognition rows exist only for included entries', async () => {
    const rows = await withCompany(w.tdb.app.db, w.ctxA, async (tx) =>
      (await tx.execute<{ amount: string; kind: string }>(sql`select amount, kind from cash_recognitions order by id`)).rows,
    );
    expect(rows).toEqual([{ amount: '1200.000000', kind: 'expense' }]);
  });

  it('rejects unbalanced entries in the service', async () => {
    await expect(
      w.run(w.ctxA, (s) =>
        createManualJournal(s, {
          date: '2026-01-17',
          memo: 'bad',
          cashTreatment: 'exclude',
          post: true,
          lines: [line('1000', 'debit', '10'), line('3000', 'credit', '9.99')],
        }),
      ),
    ).rejects.toMatchObject({ code: 'unbalanced' });
  });

  it('lets the receivable control account be renamed and renumbered, but not archived', async () => {
    const accounts = await w.run(w.ctxA, (s) => listAccounts(s));
    const ar = accounts.find((a) => a.role === 'accounts_receivable')!;
    expect(ar).toMatchObject({ code: '1100', name: 'Accounts Receivable (Evenbooks invoices)', isSystem: true });
    expect(ar.description).toMatch(/Invoices issued in Evenbooks/);
    const renamed = await w.run(w.ctxA, (s) => updateAccount(s, ar.id, { version: ar.version, code: '1200', name: 'Trade Debtors' }));
    expect(renamed).toMatchObject({ code: '1200', name: 'Trade Debtors', role: 'accounts_receivable', isSystem: true });
    await expect(w.run(w.ctxA, (s) => updateAccount(s, ar.id, { version: renamed.version, isActive: false }))).rejects.toMatchObject({ code: 'validation' });
    // Later tests address it by its default code.
    const back = await w.run(w.ctxA, (s) => updateAccount(s, ar.id, { version: renamed.version, code: '1100', name: ar.name }));
    expect(back.code).toBe('1100');
  });
  it('rejects manual postings to control accounts', async () => {
    await expect(
      w.run(w.ctxA, (s) =>
        createManualJournal(s, {
          date: '2026-01-17',
          memo: 'bad',
          cashTreatment: 'exclude',
          post: true,
          lines: [line('1100', 'debit', '10'), line('4000', 'credit', '10')],
        }),
      ),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('database rejects a directly inserted unbalanced posted entry', async () => {
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, date, memo, status, source_type, currency, cash_treatment, created_by)
          values (${w.companyA}, '2026-02-01', 'direct', 'draft', 'manual', 'USD', 'exclude', 'test') returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`insert into journal_lines (company_id, entry_id, line_no, account_id, debit) values (${w.companyA}, ${id}, 1, ${acct.get('1000')}, 100)`);
        await tx.execute(sql`insert into journal_lines (company_id, entry_id, line_no, account_id, credit) values (${w.companyA}, ${id}, 2, ${acct.get('3000')}, 90)`);
        await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(), entry_number = 999 where id = ${id}`);
      }),
    ).rejects.toSatisfy((e: unknown) => /not balanced/.test(dbErrorMessage(e)));
  });

  it('database rejects a single-line posted entry and excess precision', async () => {
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, date, memo, status, source_type, currency, cash_treatment, created_by)
          values (${w.companyA}, '2026-02-01', 'direct', 'draft', 'manual', 'USD', 'exclude', 'test') returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`insert into journal_lines (company_id, entry_id, line_no, account_id, debit) values (${w.companyA}, ${id}, 1, ${acct.get('1000')}, 100)`);
        await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(), entry_number = 998 where id = ${id}`);
      }),
    ).rejects.toSatisfy((e: unknown) => /at least two lines/.test(dbErrorMessage(e)));
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, async (tx) => {
        const r = await tx.execute<{ id: string }>(sql`
          insert into journal_entries (company_id, date, memo, status, source_type, currency, cash_treatment, created_by)
          values (${w.companyA}, '2026-02-01', 'direct', 'draft', 'manual', 'USD', 'exclude', 'test') returning id`);
        const id = r.rows[0]!.id;
        await tx.execute(sql`insert into journal_lines (company_id, entry_id, line_no, account_id, debit) values (${w.companyA}, ${id}, 1, ${acct.get('1000')}, 100.005)`);
      }),
    ).rejects.toSatisfy((e: unknown) => /precision/.test(dbErrorMessage(e)));
  });

  it('database forbids inserting an entry directly as posted', async () => {
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) =>
        tx.execute(sql`
          insert into journal_entries (company_id, date, memo, status, source_type, currency, cash_treatment, created_by, posted_at, entry_number)
          values (${w.companyA}, '2026-02-01', 'direct', 'posted', 'manual', 'USD', 'exclude', 'test', now(), 997)`),
      ),
    ).rejects.toSatisfy((e: unknown) => /inserted as drafts/.test(dbErrorMessage(e)));
  });

  it('posted entries and their lines are immutable at the database boundary', async () => {
    const list = await w.run(w.ctxA, (s) => listEntries(s, { limit: 10, status: 'posted' }));
    const posted = list.items[0]!;
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`update journal_entries set memo = 'tampered' where id = ${posted.id}`)),
    ).rejects.toSatisfy((e: unknown) => /immutable/.test(dbErrorMessage(e)));
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`update journal_lines set debit = debit + 1 where entry_id = ${posted.id} and debit > 0`)),
    ).rejects.toSatisfy((e: unknown) => /immutable/.test(dbErrorMessage(e)));
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`delete from journal_lines where entry_id = ${posted.id}`)),
    ).rejects.toSatisfy((e: unknown) => /immutable/.test(dbErrorMessage(e)));
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) => tx.execute(sql`delete from journal_entries where id = ${posted.id}`)),
    ).rejects.toSatisfy((e: unknown) => /cannot be deleted/.test(dbErrorMessage(e)));
  });

  it('idempotency: same key returns the same entry, different payload conflicts', async () => {
    const input = {
      date: '2026-01-20',
      memo: 'idem',
      cashTreatment: 'exclude' as const,
      post: true,
      lines: [line('1500', 'debit', '250'), line('1000', 'credit', '250')],
      idempotencyKey: 'test-key-0001',
    };
    const first = await w.run(w.ctxA, (s) => createManualJournal(s, input));
    const second = await w.run(w.ctxA, (s) => createManualJournal(s, input));
    expect(second.id).toBe(first.id);
    const all = await w.run(w.ctxA, (s) => listEntries(s, { limit: 50 }));
    expect(all.items.filter((e) => e.memo === 'idem')).toHaveLength(1);
    await expect(w.run(w.ctxA, (s) => createManualJournal(s, { ...input, memo: 'different' }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('drafts can be edited and posted; posting increments version', async () => {
    const draft = await w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date: '2026-01-21',
        memo: 'draft',
        cashTreatment: 'exclude',
        post: false,
        lines: [line('1500', 'debit', '10'), line('1000', 'credit', '10')],
      }),
    );
    expect(draft.status).toBe('draft');
    expect(draft.entryNumber).toBeNull();
    const updated = await w.run(w.ctxA, (s) =>
      updateDraftJournal(s, draft.id, { version: draft.version, memo: 'draft v2', lines: [line('1500', 'debit', '20'), line('1000', 'credit', '20')] }),
    );
    expect(updated.memo).toBe('draft v2');
    expect(updated.totalDebit).toBe('20.00');
    await expect(w.run(w.ctxA, (s) => updateDraftJournal(s, draft.id, { version: draft.version, memo: 'stale' }))).rejects.toMatchObject({
      code: 'version_conflict',
    });
    const posted = await w.run(w.ctxA, (s) => postDraftJournal(s, draft.id, updated.version));
    expect(posted.status).toBe('posted');
    await expect(w.run(w.ctxA, (s) => updateDraftJournal(s, draft.id, { version: posted.version, memo: 'x' }))).rejects.toMatchObject({
      code: 'immutable',
    });
  });
});

describe('period locks', () => {
  it('blocks posting into a closed period through the service and the database, and reopening is audited', async () => {
    const period = await w.run(w.ctxA, (s) => closePeriod(s, { startDate: '2025-01-01', endDate: '2025-12-31', reason: 'Year closed' }));
    expect(period.status).toBe('closed');
    await expect(
      w.run(w.ctxA, (s) =>
        createManualJournal(s, {
          date: '2025-06-30',
          memo: 'late',
          cashTreatment: 'exclude',
          post: true,
          lines: [line('1000', 'debit', '1'), line('3000', 'credit', '1')],
        }),
      ),
    ).rejects.toMatchObject({ code: 'period_locked' });
    // a draft dated in the closed period can be created but not posted
    const draft = await w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date: '2025-06-30',
        memo: 'late draft',
        cashTreatment: 'exclude',
        post: false,
        lines: [line('1000', 'debit', '1'), line('3000', 'credit', '1')],
      }),
    );
    await expect(
      withCompany(w.tdb.app.db, w.ctxA, (tx) =>
        tx.execute(sql`update journal_entries set status='posted', posted_at=now(), entry_number=990 where id = ${draft.id}`),
      ),
    ).rejects.toSatisfy((e: unknown) => /closed/.test(dbErrorMessage(e)));
    await expect(w.run(w.ctxA, (s) => closePeriod(s, { startDate: '2025-06-01', endDate: '2026-01-31' }))).rejects.toMatchObject({ code: 'conflict' });

    const reopened = await w.run(w.ctxA, (s) => reopenPeriod(s, period.id, { version: period.version, reason: 'Adjusting entry needed' }));
    expect(reopened.status).toBe('open');
    const posted = await w.run(w.ctxA, (s) => postDraftJournal(s, draft.id, draft.version));
    expect(posted.status).toBe('posted');
    const audit = await w.run(w.ctxA, (s) => listAudit(s, { limit: 50, entityType: 'accounting_period' }));
    expect(audit.items.map((a) => a.action)).toEqual(expect.arrayContaining(['period.closed', 'period.reopened']));
    expect(audit.items.find((a) => a.action === 'period.reopened')!.reason).toBe('Adjusting entry needed');
    expect((await w.run(w.ctxA, (s) => listPeriods(s))).length).toBe(1);
  });
});

describe('reversals', () => {
  it('creates a linked reversing entry and blocks a second reversal', async () => {
    const original = await w.run(w.ctxA, (s) =>
      createManualJournal(s, {
        date: '2026-02-10',
        memo: 'Supplies paid in cash',
        cashTreatment: 'include',
        post: true,
        lines: [line('5110', 'debit', '80'), line('1000', 'credit', '80')],
      }),
    );
    const reversal = await w.run(w.ctxA, (s) => reverseEntry(s, original.id, { date: '2026-02-11', reason: 'Entered twice' }));
    expect(reversal.reversesEntryId).toBe(original.id);
    expect(reversal.lines.find((l) => l.accountId === acct.get('5110'))!.credit).toBe('80.00');
    const refreshed = await w.run(w.ctxA, (s) => getEntry(s, original.id));
    expect(refreshed.reversedByEntryId).toBe(reversal.id);
    await expect(w.run(w.ctxA, (s) => reverseEntry(s, original.id, { date: '2026-02-12', reason: 'again' }))).rejects.toMatchObject({
      code: 'invalid_state',
    });
    // cash recognition nets to zero for the pair
    const rows = await withCompany(w.tdb.app.db, w.ctxA, async (tx) =>
      (await tx.execute<{ total: string }>(sql`select coalesce(sum(amount),0)::text as total from cash_recognitions where account_id = ${acct.get('5110')}`)).rows,
    );
    expect(Number(rows[0]!.total)).toBe(0);
  });

  it('rejects reversals dated before the original', async () => {
    const list = await w.run(w.ctxA, (s) => listEntries(s, { limit: 50, status: 'posted' }));
    const target = list.items.find((e) => e.memo === 'Owner funds the business')!;
    await expect(w.run(w.ctxA, (s) => reverseEntry(s, target.id, { date: '2025-12-31', reason: 'x' }))).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('opening balances', () => {
  it('posts against opening balance equity and refuses control accounts', async () => {
    const e = await w.run(w.ctxB, async (s) => {
      const b = await w.accountsByCode(w.ctxB);
      return postOpeningBalances(s, {
        date: '2025-12-31',
        lines: [
          { accountId: b.get('1000')!, balance: '10000' },
          { accountId: b.get('2000')!, balance: '2500' },
          { accountId: b.get('1500')!, balance: '4000' },
        ],
      });
    });
    expect(e.totalDebit).toBe('14000.00');
    const obe = e.lines.find((l) => l.accountCode === '3900')!;
    expect(obe.credit).toBe('11500.00');
    await expect(
      w.run(w.ctxB, async (s) => {
        const b = await w.accountsByCode(w.ctxB);
        return postOpeningBalances(s, { date: '2025-12-31', lines: [{ accountId: b.get('1100')!, balance: '100' }] });
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});
