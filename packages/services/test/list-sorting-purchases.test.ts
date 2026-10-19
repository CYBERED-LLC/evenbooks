import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page, SortDirection } from '@evenbooks/contracts';
import {
  createContact,
  createDraftCreditNote,
  createDraftInvoice,
  createPayment,
  createPurchase,
  issueCreditNote,
  issueInvoice,
  listCreditNotes,
  listPayments,
  listPurchases,
  type ServiceContext,
} from '../src/index';
import { createWorld, type TestWorld } from './helpers';

// Sorting + keyset paging + totals for the purchases, payments and credit notes lists.
// Each fixture has ties on every sort key (and nulls where the column is nullable),
// so paging only works if the id tie-breaker is applied consistently.

let w: TestWorld;
let acct: Map<string, string>;
const contacts: Record<'alpha' | 'bravo' | 'charlie', string> = { alpha: '', bravo: '', charlie: '' };

beforeAll(async () => {
  w = await createWorld();
  acct = await w.accountsByCode(w.ctxA);
  // 'Bravo' is capitalised to check that name sorts ignore case.
  for (const [key, name] of [
    ['alpha', 'alpha'],
    ['bravo', 'Bravo'],
    ['charlie', 'charlie'],
  ] as const) {
    contacts[key] = (await w.run(w.ctxA, (s) => createContact(s, { name, isCustomer: true, isVendor: true }))).id;
  }

  // Purchases: 8 rows, ties on date, total, vendor (incl. no vendor) and reference (incl. none).
  const purchases: { date: string; total: string; vendor: keyof typeof contacts | null; ref: string | null }[] = [
    { date: '2026-04-01', total: '10', vendor: 'alpha', ref: 'ra' },
    { date: '2026-04-01', total: '25', vendor: 'bravo', ref: null },
    { date: '2026-04-02', total: '10', vendor: null, ref: 'rb' },
    { date: '2026-04-03', total: '99.5', vendor: 'charlie', ref: 'ra' },
    { date: '2026-04-03', total: '25', vendor: 'bravo', ref: 'rc' },
    { date: '2026-04-03', total: '5', vendor: null, ref: null },
    { date: '2026-04-04', total: '10', vendor: 'alpha', ref: 'rb' },
    { date: '2026-04-05', total: '100', vendor: 'charlie', ref: 'rc' },
  ];
  for (const p of purchases) {
    await w.run(w.ctxA, (s) =>
      createPurchase(s, {
        date: p.date,
        contactId: p.vendor ? contacts[p.vendor] : null,
        paidFromAccountId: acct.get('1000')!,
        direction: 'outflow',
        reference: p.ref,
        lines: [{ accountId: acct.get('5110')!, description: 'x', amount: p.total }],
        attachmentIds: [],
      }),
    );
  }

  // Payments: 7 rows. One invoice for alpha takes part of two payments so unapplied differs from amount.
  const draft = await w.run(w.ctxA, (s) =>
    createDraftInvoice(s, { contactId: contacts.alpha, issueDate: '2026-04-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '1000', incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }),
  );
  const inv = await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
  const payments: { date: string; amount: string; customer: keyof typeof contacts | null; allocate?: string }[] = [
    { date: '2026-05-01', amount: '50', customer: 'alpha', allocate: '30' },
    { date: '2026-05-01', amount: '20', customer: 'bravo' },
    { date: '2026-05-02', amount: '50', customer: null },
    { date: '2026-05-03', amount: '75', customer: 'charlie' },
    { date: '2026-05-03', amount: '20', customer: 'bravo' },
    { date: '2026-05-03', amount: '60', customer: 'alpha', allocate: '60' },
    { date: '2026-05-04', amount: '20', customer: null },
  ];
  for (const p of payments) {
    await w.run(w.ctxA, (s) =>
      createPayment(s, {
        contactId: p.customer ? contacts[p.customer] : undefined,
        date: p.date,
        amount: p.amount,
        depositAccountId: acct.get('1000')!,
        method: 'check',
        isRefundableDeposit: false,
        allocations: p.allocate ? [{ invoiceId: inv.id, amount: p.allocate }] : [],
      }),
    );
  }

  // Credit notes: 6 rows, two drafts (no number), ties on issue date, total and customer.
  const notes: { date: string; total: string; customer: keyof typeof contacts; issue: boolean }[] = [
    { date: '2026-06-01', total: '40', customer: 'charlie', issue: true },
    { date: '2026-06-01', total: '15', customer: 'alpha', issue: false },
    { date: '2026-06-02', total: '40', customer: 'bravo', issue: true },
    { date: '2026-06-03', total: '15', customer: 'bravo', issue: true },
    { date: '2026-06-03', total: '70', customer: 'alpha', issue: false },
    { date: '2026-06-04', total: '15', customer: 'charlie', issue: true },
  ];
  for (const n of notes) {
    const cn = await w.run(w.ctxA, (s) =>
      createDraftCreditNote(s, { contactId: contacts[n.customer], issueDate: n.date, lines: [{ description: 'Credit', quantity: '1', unitPrice: n.total, incomeAccountId: acct.get('4100')!, taxRateIds: [] }] }),
    );
    if (n.issue) await w.run(w.ctxA, (s) => issueCreditNote(s, cn.id, { version: cn.version }));
  }
});
afterAll(async () => {
  await w.destroy();
});

type Lister<T, Q> = (s: ServiceContext, q: Q) => Promise<Page<T>>;

async function pageThrough<T extends { id: string }, Q extends { limit: number; cursor?: string }>(list: Lister<T, Q>, q: Omit<Q, 'limit' | 'cursor'>, limit = 3) {
  const seen: T[] = [];
  const totals = new Set<number | undefined>();
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = await w.run(w.ctxA, (s) => list(s, { ...q, limit, cursor } as Q));
    seen.push(...page.items);
    totals.add(page.total);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { seen, totals: [...totals] };
}

/** Consecutive rows are in order for the key (ties allowed; the id breaks them server-side). */
function expectOrdered<T>(rows: T[], key: (r: T) => string | number, dir: SortDirection) {
  for (let i = 1; i < rows.length; i++) {
    const a = key(rows[i - 1]!);
    const b = key(rows[i]!);
    if (dir === 'asc') expect(a <= b, `${String(a)} <= ${String(b)} at ${i}`).toBe(true);
    else expect(a >= b, `${String(a)} >= ${String(b)} at ${i}`).toBe(true);
  }
}

async function checkSort<T extends { id: string }, Q extends { limit: number; cursor?: string }>(
  list: Lister<T, Q>,
  sort: string,
  key: (r: T) => string | number,
  n: number,
  extra: Record<string, unknown> = {},
) {
  const asc = await pageThrough(list, { ...extra, sort, dir: 'asc' } as unknown as Omit<Q, 'limit' | 'cursor'>);
  const desc = await pageThrough(list, { ...extra, sort, dir: 'desc' } as unknown as Omit<Q, 'limit' | 'cursor'>, 2);
  for (const r of [asc, desc]) {
    expect(r.seen).toHaveLength(n);
    expect(new Set(r.seen.map((x) => x.id)).size).toBe(n);
    expect(r.totals).toEqual([n]);
  }
  expectOrdered(asc.seen, key, 'asc');
  expectOrdered(desc.seen, key, 'desc');
  // (key, id) is a total order, so descending is exactly ascending reversed.
  expect(desc.seen.map((x) => x.id)).toEqual([...asc.seen].reverse().map((x) => x.id));
  return asc.seen;
}

const num = (v: string) => Number(v);

describe('purchases list sorting', () => {
  it('defaults to date, newest first, with a total', async () => {
    const def = await pageThrough(listPurchases, {});
    expect(def.seen).toHaveLength(8);
    expect(def.totals).toEqual([8]);
    const explicit = await pageThrough(listPurchases, { sort: 'date', dir: 'desc' });
    expect(def.seen.map((p) => p.id)).toEqual(explicit.seen.map((p) => p.id));
    expectOrdered(def.seen, (p) => p.date, 'desc');
  });

  it('sorts by date, total, vendor and reference both ways without skipping or repeating', async () => {
    await checkSort(listPurchases, 'date', (p) => p.date, 8);
    await checkSort(listPurchases, 'total', (p) => num(p.total), 8);
    const byVendor = await checkSort(listPurchases, 'vendor', (p) => (p.contactName ?? '').toLowerCase(), 8);
    // No vendor first, then alpha, Bravo (case-insensitive), charlie.
    expect(byVendor.map((p) => p.contactName ?? null)).toEqual([null, null, 'alpha', 'alpha', 'Bravo', 'Bravo', 'charlie', 'charlie']);
    const byRef = await checkSort(listPurchases, 'reference', (p) => p.reference ?? '', 8);
    expect(byRef.slice(0, 2).map((p) => p.reference)).toEqual([null, null]);
  });

  it('counts and sorts within the filters', async () => {
    await checkSort(listPurchases, 'total', (p) => num(p.total), 2, { contactId: contacts.bravo });
    await checkSort(listPurchases, 'vendor', (p) => (p.contactName ?? '').toLowerCase(), 5, { from: '2026-04-03' });
  });
});

describe('payments list sorting', () => {
  it('defaults to date, newest first, with a total', async () => {
    const def = await pageThrough(listPayments, {});
    expect(def.seen).toHaveLength(7);
    expect(def.totals).toEqual([7]);
    expectOrdered(def.seen, (p) => p.date, 'desc');
  });

  it('sorts by date, amount, customer and unapplied both ways without skipping or repeating', async () => {
    await checkSort(listPayments, 'date', (p) => p.date, 7);
    await checkSort(listPayments, 'amount', (p) => num(p.amount), 7);
    const byCustomer = await checkSort(listPayments, 'customer', (p) => (p.contactName ?? '').toLowerCase(), 7);
    expect(byCustomer.map((p) => p.contactName ?? null)).toEqual([null, null, 'alpha', 'alpha', 'Bravo', 'Bravo', 'charlie']);
    const byUnapplied = await checkSort(listPayments, 'unapplied', (p) => num(p.unappliedAmount), 7);
    expect(num(byUnapplied[0]!.unappliedAmount)).toBe(0);
  });

  it('counts and sorts within the filters', async () => {
    await checkSort(listPayments, 'amount', (p) => num(p.amount), 3, { unappliedOnly: true, from: '2026-05-03' });
  });
});

describe('credit notes list sorting', () => {
  it('defaults to issue date, newest first, with a total', async () => {
    const def = await pageThrough(listCreditNotes, {});
    expect(def.seen).toHaveLength(6);
    expect(def.totals).toEqual([6]);
    expectOrdered(def.seen, (c) => c.issueDate, 'desc');
  });

  it('sorts by issue date, number, total and customer both ways without skipping or repeating', async () => {
    await checkSort(listCreditNotes, 'issueDate', (c) => c.issueDate, 6);
    const byNumber = await checkSort(listCreditNotes, 'number', (c) => c.number ?? '', 6);
    // drafts (no number) first, then CN-0001…
    expect(byNumber.map((c) => c.number)).toEqual([null, null, 'CN-0001', 'CN-0002', 'CN-0003', 'CN-0004']);
    await checkSort(listCreditNotes, 'total', (c) => num(c.total), 6);
    await checkSort(listCreditNotes, 'customer', (c) => (c.contactName ?? '').toLowerCase(), 6);
  });

  it('counts and sorts within the filters, and search matches the customer name', async () => {
    await checkSort(listCreditNotes, 'number', (c) => c.number ?? '', 4, { status: 'issued' });
    const found = await pageThrough(listCreditNotes, { q: 'brav' });
    expect(found.totals).toEqual([2]);
    expect(found.seen.map((c) => c.contactName)).toEqual(['Bravo', 'Bravo']);
  });

  it('ignores a cursor from another sort and starts over', async () => {
    const first = await w.run(w.ctxA, (s) => listCreditNotes(s, { limit: 2 }));
    const other = await w.run(w.ctxA, (s) => listCreditNotes(s, { limit: 2, sort: 'total', dir: 'asc', cursor: first.nextCursor! }));
    const fresh = await w.run(w.ctxA, (s) => listCreditNotes(s, { limit: 2, sort: 'total', dir: 'asc' }));
    expect(other.items.map((c) => c.id)).toEqual(fresh.items.map((c) => c.id));
  });
});
