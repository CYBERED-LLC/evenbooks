import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ContactDto, InvoiceDto, ListContactsQuery, ListInvoicesQuery, Page } from '@evenbooks/contracts';
import { createContact, createDraftInvoice, issueInvoice, listContacts, listInvoices } from '../src/index';
import { createWorld, type TestWorld } from './helpers';

let w: TestWorld;
const tag = 'isort';

beforeAll(async () => {
  w = await createWorld();
  const acct = await w.accountsByCode(w.ctxA);
  // Mixed-case names so the name sort has to be case-insensitive; "bravo" appears twice (ties).
  const names = ['bravo Co', 'Alpha Ltd', 'charlie Inc', 'Bravo Co'];
  const customers: string[] = [];
  for (const name of names) customers.push((await w.run(w.ctxA, (s) => createContact(s, { name: `${tag} ${name}`, isCustomer: true, isVendor: false }))).id);
  // Eight invoices: ties on issue date, due date and total; three stay drafts (no number).
  const specs = [
    { c: 0, date: '2026-04-01', price: '100', terms: 30, issue: true },
    { c: 1, date: '2026-04-01', price: '250', terms: 15, issue: true },
    { c: 2, date: '2026-04-02', price: '100', terms: 30, issue: false },
    { c: 3, date: '2026-04-03', price: '75.5', terms: 0, issue: true },
    { c: 0, date: '2026-04-03', price: '250', terms: 30, issue: false },
    { c: 1, date: '2026-04-03', price: '10', terms: 60, issue: true },
    { c: 2, date: '2026-04-05', price: '100', terms: 30, issue: true },
    { c: 3, date: '2026-04-06', price: '999', terms: 30, issue: false },
  ];
  for (const [i, sp] of specs.entries()) {
    const draft = await w.run(w.ctxA, (s) =>
      createDraftInvoice(s, {
        contactId: customers[sp.c]!,
        issueDate: sp.date,
        termsDays: sp.terms,
        memo: `${tag} ${i}`,
        lines: [{ description: 'Work', quantity: '1', unitPrice: sp.price, incomeAccountId: acct.get('4100')!, taxRateIds: [] }],
      }),
    );
    if (sp.issue) await w.run(w.ctxA, (s) => issueInvoice(s, draft.id, { version: draft.version }));
  }
});
afterAll(async () => {
  await w.destroy();
});

async function pageInvoices(q: Partial<ListInvoicesQuery>, limit = 3) {
  const seen: InvoiceDto[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  for (let i = 0; i < 20; i++) {
    const page: Page<InvoiceDto> = await w.run(w.ctxA, (s) => listInvoices(s, { limit, q: tag, ...q, cursor }));
    seen.push(...page.items);
    total = page.total;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);
  return { seen, total };
}

const cmpNum = (a: string, b: string) => Number(a) - Number(b);
const cmpText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe('invoice list sorting with keyset paging', () => {
  it('defaults to issue date, newest first, and counts every match', async () => {
    const { seen, total } = await pageInvoices({});
    expect(total).toBe(8);
    expect(seen).toHaveLength(8);
    const dates = seen.map((r) => r.issueDate);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('filters narrow the total too', async () => {
    const drafts = await pageInvoices({ status: 'draft' });
    expect(drafts.total).toBe(3);
    expect(drafts.seen).toHaveLength(3);
  });

  it.each([
    ['dueDate', (r: InvoiceDto) => r.dueDate, cmpText],
    ['total', (r: InvoiceDto) => r.total, cmpNum],
    ['balanceDue', (r: InvoiceDto) => r.balanceDue, cmpNum],
    ['number', (r: InvoiceDto) => r.number ?? '', cmpText],
    ['customer', (r: InvoiceDto) => r.customerSnapshot.name.toLowerCase(), cmpText],
  ] as const)('sorts by %s both ways across pages', async (sort, value, cmp) => {
    const asc = await pageInvoices({ sort, dir: 'asc' });
    expect(asc.seen).toHaveLength(8);
    const vals = asc.seen.map(value);
    expect(vals).toEqual([...vals].sort(cmp));
    const desc = await pageInvoices({ sort, dir: 'desc' });
    expect(desc.seen.map((r) => r.id)).toEqual([...asc.seen].reverse().map((r) => r.id));
  });

  it('puts drafts (no number) first when sorting by number ascending', async () => {
    const { seen } = await pageInvoices({ sort: 'number', dir: 'asc' });
    expect(seen.slice(0, 3).every((r) => r.number === null)).toBe(true);
    expect(seen.slice(3).every((r) => r.number !== null)).toBe(true);
  });

  it('restarts from the top when the cursor was made for another sort', async () => {
    const first = await w.run(w.ctxA, (s) => listInvoices(s, { limit: 2, q: tag }));
    const other = await w.run(w.ctxA, (s) => listInvoices(s, { limit: 2, q: tag, sort: 'total', dir: 'asc', cursor: first.nextCursor! }));
    const fresh = await w.run(w.ctxA, (s) => listInvoices(s, { limit: 2, q: tag, sort: 'total', dir: 'asc' }));
    expect(other.items.map((r) => r.id)).toEqual(fresh.items.map((r) => r.id));
  });
});

async function pageContacts(q: Partial<ListContactsQuery>, limit = 2) {
  const seen: ContactDto[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  for (let i = 0; i < 20; i++) {
    const page: Page<ContactDto> = await w.run(w.ctxA, (s) => listContacts(s, { limit, q: tag, ...q, cursor }));
    seen.push(...page.items);
    total = page.total;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);
  return { seen, total };
}

describe('contact list sorting', () => {
  it('defaults to name A–Z, case-insensitive, with ties paged by id', async () => {
    const { seen, total } = await pageContacts({});
    expect(total).toBe(4);
    const names = seen.map((c) => c.name.toLowerCase());
    expect(names).toEqual([...names].sort(cmpText));
    expect(names[0]).toBe(`${tag} alpha ltd`);
    const desc = await pageContacts({ sort: 'name', dir: 'desc' });
    expect(desc.seen.map((c) => c.id)).toEqual([...seen].reverse().map((c) => c.id));
  });

  it('sorts by created date both ways', async () => {
    const newest = await pageContacts({ sort: 'createdAt', dir: 'desc' }, 3);
    expect(newest.seen).toHaveLength(4);
    const created = newest.seen.map((c) => c.createdAt);
    expect(created).toEqual([...created].sort().reverse());
    const oldest = await pageContacts({ sort: 'createdAt', dir: 'asc' }, 3);
    expect(oldest.seen.map((c) => c.id)).toEqual([...newest.seen].reverse().map((c) => c.id));
  });
});
