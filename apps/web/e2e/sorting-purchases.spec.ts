import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, CreditNoteDto, PaymentDto, PurchaseDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS } from './helpers';

// Column sorting and totals on the purchases, payments and credit notes lists.
// Each test scopes the list with a unique search token so other data in the dev DB doesn't interfere.

function token(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function accounts(page: Page) {
  const list = await apiGet<AccountDto[]>(page, '/api/accounts');
  const byCode = (code: string) => list.find((a) => a.code === code)!;
  return { checking: byCode('1000'), supplies: byCode('5110'), income: byCode('4100') };
}

async function contact(page: Page, name: string) {
  return apiPost<ContactDto>(page, '/api/contacts', { name, isCustomer: true, isVendor: true });
}

async function clickSort(page: Page, table: string, header: string) {
  await page.getByRole('table', { name: table }).getByRole('button', { name: header, exact: true }).click();
}

test.describe('List sorting: purchases, payments, credit notes', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
  });

  test('purchases sort by total, vendor and reference; search chip and total stay', async ({ page }) => {
    test.setTimeout(90_000);
    const t = token('psort');
    const { checking, supplies } = await accounts(page);
    const a = await contact(page, `${t} A vendor`);
    const b = await contact(page, `${t} B vendor`);
    const mk = (date: string, contactId: string | null, amount: string, reference: string) =>
      apiPost<PurchaseDto>(page, '/api/purchases', { date, contactId, paidFromAccountId: checking.id, direction: 'outflow', reference, memo: `${t} memo`, lines: [{ accountId: supplies.id, amount }] });
    await mk('2026-03-01', b.id, '30', 'ref-c');
    await mk('2026-03-02', null, '5', 'ref-a');
    await mk('2026-03-03', a.id, '12', 'ref-b');

    await gotoReady(page, `/purchases?q=${t}`);
    const rows = page.getByRole('table', { name: 'Expenses' }).locator('tbody tr');
    // Default: newest first; the header shows it.
    await expect(rows).toHaveText([/A vendor/, /no vendor/, /B vendor/]);
    await expect(page.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'descending');
    await expect(page.getByText('3 expenses')).toBeVisible();

    await clickSort(page, 'Expenses', 'Total');
    await expect(page).toHaveURL(/sort=total&dir=desc/);
    await expect(rows).toHaveText([/\$30\.00/, /\$12\.00/, /\$5\.00/]);
    await expect(page.getByRole('columnheader', { name: 'Total' })).toHaveAttribute('aria-sort', 'descending');
    await expect(page.getByRole('columnheader', { name: 'Date' })).toHaveAttribute('aria-sort', 'none');
    await clickSort(page, 'Expenses', 'Total');
    await expect(page).toHaveURL(/dir=asc/);
    await expect(rows).toHaveText([/\$5\.00/, /\$12\.00/, /\$30\.00/]);

    // Text columns start A→Z; no vendor sorts first.
    await clickSort(page, 'Expenses', 'Vendor');
    await expect(page).toHaveURL(/sort=vendor&dir=asc/);
    await expect(rows).toHaveText([/no vendor/, /A vendor/, /B vendor/]);
    await clickSort(page, 'Expenses', 'Note / reference');
    await expect(rows).toHaveText([/ref-a/, /ref-b/, /ref-c/]);

    // Filters still apply with a sort chosen, and the search chip survives.
    await expect(page.getByText(`Search: ${t}`)).toBeVisible();
    await expect(page.getByText('3 expenses')).toBeVisible();
    await page.getByLabel('From date').fill('2026-03-02');
    await expect(rows).toHaveText([/ref-a/, /ref-b/]);
    await expect(page.getByText('2 expenses')).toBeVisible();
    await expect(page).toHaveURL(/sort=reference/);
  });

  test('payments sort by amount, customer and unapplied', async ({ page }) => {
    test.setTimeout(90_000);
    const t = token('paysort');
    const { checking, income } = await accounts(page);
    const a = await contact(page, `${t} A cust`);
    const b = await contact(page, `${t} B cust`);
    const draft = await apiPost<{ id: string; version: number }>(page, '/api/invoices', {
      contactId: a.id,
      issueDate: '2026-03-01',
      lines: [{ description: 'Work', quantity: '1', unitPrice: '100', incomeAccountId: income.id, taxRateIds: [] }],
    });
    const inv = await apiPost<{ id: string }>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version, idempotencyKey: `e2e-issue-${draft.id}` });
    const mk = (date: string, contactId: string | undefined, amount: string, allocate?: string) =>
      apiPost<PaymentDto>(page, '/api/payments', {
        contactId,
        date,
        amount,
        depositAccountId: checking.id,
        method: 'check',
        memo: `${t} memo`,
        isRefundableDeposit: false,
        allocations: allocate ? [{ invoiceId: inv.id, amount: allocate }] : [],
      });
    await mk('2026-03-02', a.id, '80', '70'); // unapplied 10
    await mk('2026-03-03', b.id, '25'); // unapplied 25
    await mk('2026-03-04', undefined, '40'); // unapplied 40

    await gotoReady(page, `/payments?q=${t}`);
    const rows = page.getByRole('table', { name: 'Payments' }).locator('tbody tr');
    await expect(rows).toHaveText([/No customer/, /B cust/, /A cust/]);
    await expect(page.getByText('3 payments')).toBeVisible();

    await clickSort(page, 'Payments', 'Amount');
    await expect(rows).toHaveText([/A cust/, /No customer/, /B cust/]);
    await clickSort(page, 'Payments', 'Credit to use');
    await expect(page).toHaveURL(/sort=unapplied&dir=desc/);
    await expect(rows).toHaveText([/No customer/, /B cust/, /A cust/]);
    await clickSort(page, 'Payments', 'Credit to use');
    await expect(rows).toHaveText([/A cust/, /B cust/, /No customer/]);
    await clickSort(page, 'Payments', 'Customer');
    await expect(rows).toHaveText([/No customer/, /A cust/, /B cust/]);
    await clickSort(page, 'Payments', 'Customer');
    await expect(rows).toHaveText([/B cust/, /A cust/, /No customer/]);

    // The unapplied filter keeps the sort.
    await page.getByLabel('Has credit to use').click();
    await expect(page).toHaveURL(/unapplied=1/);
    await expect(page).toHaveURL(/sort=customer&dir=desc/);
    await expect(rows).toHaveCount(3);
    await expect(page.getByText('Has credit to use').first()).toBeVisible();
  });

  test('credit notes sort by number, total and customer and page with a total', async ({ page }) => {
    test.setTimeout(90_000);
    const t = token('cnsort');
    const { income } = await accounts(page);
    const a = await contact(page, `${t} A cust`);
    const b = await contact(page, `${t} B cust`);
    const mk = async (contactId: string, issueDate: string, amount: string, issue: boolean) => {
      const cn = await apiPost<CreditNoteDto>(page, '/api/credit-notes', {
        contactId,
        issueDate,
        reason: `${t} reason`,
        lines: [{ description: 'Credit', quantity: '1', unitPrice: amount, incomeAccountId: income.id, taxRateIds: [] }],
      });
      return issue ? apiPost<CreditNoteDto>(page, `/api/credit-notes/${cn.id}/issue`, { version: cn.version, idempotencyKey: `e2e-cn-${cn.id}` }) : cn;
    };
    const first = await mk(b.id, '2026-03-01', '15', true);
    const second = await mk(a.id, '2026-03-02', '40', true);
    await mk(b.id, '2026-03-03', '25', false);

    await gotoReady(page, `/credit-notes?q=${t}&limit=2`);
    const rows = page.getByRole('table', { name: 'Credit notes' }).locator('tbody tr');
    // Default: newest issue date first; two per page with the overall count.
    await expect(rows).toHaveText([/Draft/, new RegExp(second.number!)]);
    await expect(page.getByText('Showing 1–2 of 3 credit notes')).toBeVisible();

    await clickSort(page, 'Credit notes', 'Number');
    await expect(page).toHaveURL(/sort=number&dir=desc/);
    await expect(rows).toHaveText([new RegExp(second.number!), new RegExp(first.number!)]);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(rows).toHaveText([/Draft/]);
    await expect(page.getByText('Showing 3–3 of 3 credit notes')).toBeVisible();

    // Changing the sort starts from the first page again.
    await clickSort(page, 'Credit notes', 'Total');
    await expect(page).not.toHaveURL(/cursor=/);
    await expect(rows).toHaveText([/\$40\.00/, /\$25\.00/]);
    await clickSort(page, 'Credit notes', 'Customer');
    await expect(rows).toHaveText([/A cust/, /B cust/]);
    await expect(page.getByText('Showing 1–2 of 3 credit notes')).toBeVisible();

    // Search also matches the customer name.
    await gotoReady(page, `/credit-notes?q=${encodeURIComponent(`${t} B cust`)}`);
    await expect(rows).toHaveCount(2);
    await expect(page.getByText('2 credit notes')).toBeVisible();
  });
});
