import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, JournalEntryDto, PurchaseDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, pickOption, unique, menuItem } from './helpers';

const label = (a: AccountDto) => `${a.code} ${a.name}`;

async function seedAccounts(page: Page) {
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const byCode = (code: string) => {
    const a = accounts.find((x) => x.code === code);
    expect(a, `account ${code} exists`).toBeTruthy();
    return a!;
  };
  return { card: byCode('2000'), supplies: byCode('5110'), checking: byCode('1000') };
}

test.describe('Purchases, payments and journal usability', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
  });

  test('vendor defaults, post and new, duplicate, receipt delete confirmation', async ({ page }) => {
    test.setTimeout(120_000);
    const { card, supplies } = await seedAccounts(page);
    const vendorName = unique('Defaults Vendor');
    const vendor = await apiPost<ContactDto>(page, '/api/contacts', { name: vendorName, isCustomer: false, isVendor: true });
    // The vendor's last receipt: paid by card, coded to Supplies.
    await apiPost<PurchaseDto>(page, '/api/purchases', {
      date: '2026-05-01',
      contactId: vendor.id,
      paidFromAccountId: card.id,
      direction: 'outflow',
      lines: [{ accountId: supplies.id, description: 'Paper', amount: '10' }],
    });

    await gotoReady(page, '/purchases/new');
    await page.getByLabel(/^Date/).fill('2026-05-20');
    await pickOption(page.getByLabel(/^Vendor/), vendorName);
    // Picking the vendor fills "Paid from" and the first line's account from their last receipt.
    await expect(page.getByLabel(/^Paid from/)).toHaveValue(label(card));
    await expect(page.getByLabel('Line 1 category')).toHaveValue(label(supplies));
    await expect(page.getByText('Filled in from your last expense with this vendor.')).toBeVisible();
    await page.getByLabel('Line 1 amount').fill('12.34');
    await page.getByLabel('Line 1 amount').blur();
    await expect(page.getByLabel('Line 1 amount')).toHaveValue('12.34');

    // Post and new: stays on the form, keeps the date and paid-from, clears the rest.
    await page.getByRole('button', { name: 'Save and new' }).click();
    await expect(page.getByText('Expense saved · $12.34')).toBeVisible();
    await expect(page).toHaveURL(/\/purchases\/new$/);
    await expect(page.getByLabel(/^Date/)).toHaveValue('2026-05-20');
    await expect(page.getByLabel(/^Paid from/)).toHaveValue(label(card));
    await expect(page.getByLabel(/^Vendor/)).toHaveValue('');
    await expect(page.getByLabel('Line 1 amount')).toHaveValue('');
    await expect(page.getByLabel(/^Vendor/)).toBeFocused();

    const afterFirst = await apiGet<{ items: PurchaseDto[] }>(page, `/api/purchases?contactId=${vendor.id}&limit=10`);
    expect(afterFirst.items.map((p) => p.total)).toEqual(['12.34', '10.00']);
    expect(afterFirst.items[0]!.date).toBe('2026-05-20');

    // Second receipt in the batch, with an uploaded receipt file.
    await pickOption(page.getByLabel(/^Vendor/), vendorName);
    await expect(page.getByLabel('Line 1 category')).toHaveValue(label(supplies));
    await page.getByLabel('Line 1 amount').fill('5');
    await page.getByLabel('Line 1 amount').blur();
    await expect(page.getByLabel('Line 1 amount')).toHaveValue('5.00');
    await page.getByLabel(/^Receipts/).setInputFiles({ name: 'usability-receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await expect(page.getByRole('list', { name: 'Receipt uploads' }).getByText('Uploaded')).toBeVisible();
    await page.getByRole('button', { name: 'Save expense' }).click();
    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('purchase-total')).toHaveText('$5.00');

    // Deleting a receipt asks first; cancelling keeps it.
    const del = page.getByRole('button', { name: 'Delete usability-receipt.pdf' });
    await del.click();
    const confirm = page.getByRole('dialog', { name: 'Delete usability-receipt.pdf?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(del).toBeVisible();
    await del.click();
    await page.getByRole('dialog', { name: 'Delete usability-receipt.pdf?' }).getByRole('button', { name: 'Delete receipt' }).click();
    await expect(page.getByText('Receipt deleted')).toBeVisible();
    await expect(page.getByText('No receipts attached')).toBeVisible();

    // Duplicate starts a new purchase with the same vendor, accounts and lines, dated today.
    await page.getByRole('link', { name: 'Duplicate' }).click();
    await expect(page).toHaveURL(/\/purchases\/new\?copyFrom=[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Record expense (copy)' })).toBeVisible();
    await expect(page.getByLabel(/^Vendor/)).toHaveValue(vendorName);
    await expect(page.getByLabel(/^Paid from/)).toHaveValue(label(card));
    await expect(page.getByLabel('Line 1 category')).toHaveValue(label(supplies));
    await expect(page.getByLabel('Line 1 amount')).toHaveValue('5.00');
    await page.getByRole('button', { name: 'Save expense' }).click();
    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('purchase-total')).toHaveText('$5.00');
    const all = await apiGet<{ items: PurchaseDto[] }>(page, `/api/purchases?contactId=${vendor.id}&limit=10`);
    expect(all.items).toHaveLength(4);
  });

  test('purchases list: vendor filter chip and Previous paging', async ({ page }) => {
    test.setTimeout(180_000);
    const { card, supplies } = await seedAccounts(page);
    const vendorName = unique('Paging Vendor');
    const vendor = await apiPost<ContactDto>(page, '/api/contacts', { name: vendorName, isCustomer: false, isVendor: true });
    // 51 purchases: one more than a page.
    for (let batch = 0; batch < 51; batch += 6) {
      await Promise.all(
        Array.from({ length: Math.min(6, 51 - batch) }, (_, k) =>
          apiPost<PurchaseDto>(page, '/api/purchases', {
            date: `2026-03-${String(((batch + k) % 28) + 1).padStart(2, '0')}`,
            contactId: vendor.id,
            paidFromAccountId: card.id,
            direction: 'outflow',
            lines: [{ accountId: supplies.id, description: `Item ${batch + k}`, amount: '1' }],
          }),
        ),
      );
    }

    await gotoReady(page, `/purchases?contactId=${vendor.id}`);
    await expect(page.getByRole('button', { name: `Remove filter: Vendor: ${vendorName}` })).toBeVisible();
    await expect(page.getByText('Showing 1–50 of 51 expenses')).toBeVisible();
    await expect(page.getByTestId('purchases-page-total')).toHaveText('Net spent $50.00');
    await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Showing 51–51 of 51 expenses')).toBeVisible();
    await expect(page.getByTestId('purchases-page-total')).toHaveText('Net spent $1.00');
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await expect(page.getByText('Showing 1–50 of 51 expenses')).toBeVisible();
    await expect(page).not.toHaveURL(/cursor=/);

    // Whole-row click opens the purchase.
    await page.getByRole('table', { name: 'Expenses' }).getByRole('row').nth(1).getByRole('cell').first().click();
    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/);
  });

  test('journal: duplicate an entry, then delete the draft copy after confirming', async ({ page }) => {
    test.setTimeout(120_000);
    const { checking, supplies } = await seedAccounts(page);
    const memo = unique('Duplicate me');
    const entry = await apiPost<JournalEntryDto>(page, '/api/journal', {
      date: '2026-04-20',
      memo,
      cashTreatment: 'include',
      post: true,
      lines: [
        { accountId: supplies.id, debit: '33.00' },
        { accountId: checking.id, credit: '33.00' },
      ],
    });

    await gotoReady(page, `/journal/${entry.id}`);
    await page.getByRole('link', { name: 'Duplicate' }).click();
    await expect(page).toHaveURL(new RegExp(`/journal/new\\?copyFrom=${entry.id}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('copy of #');
    await expect(page.getByLabel('Memo', { exact: true })).toHaveValue(memo);
    await expect(page.getByLabel('Line 1 account')).toHaveValue(label(supplies));
    await expect(page.getByLabel('Line 2 account')).toHaveValue(label(checking));
    await page.getByRole('button', { name: 'Save as draft' }).click();
    await expect(page).toHaveURL(/\/journal\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 }).getByText('draft')).toBeVisible();
    const draftUrl = page.url();

    // Delete asks first; cancelling keeps the draft.
    await (await menuItem(page, 'Delete draft')).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this draft entry?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page).toHaveURL(draftUrl);

    await (await menuItem(page, 'Delete draft')).click();
    await page.getByRole('dialog', { name: 'Delete this draft entry?' }).getByRole('button', { name: 'Delete draft' }).click();
    await expect(page).toHaveURL(/\/journal$/);
    const session = await page.request.get('/api/session');
    const { company } = (await session.json()) as { company: { id: string } };
    const gone = await page.request.get(draftUrl.replace(/.*\/journal\//, '/api/journal/'), { headers: { 'x-company-id': company.id } });
    expect(gone.status()).toBe(404);
  });

  test('payments: record and new keeps the date, method and deposit account', async ({ page }) => {
    test.setTimeout(120_000);
    const { checking } = await seedAccounts(page);
    const a = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Batch Payer A'), isCustomer: true, isVendor: false });

    await gotoReady(page, '/payments/new');
    await pickOption(page.getByLabel(/^Customer/), a.name);
    await page.getByLabel(/^Date/).fill('2026-06-15');
    await page.getByLabel(/^Amount/).fill('75');
    await page.getByLabel(/^Method/).selectOption('check');
    await pickOption(page.getByLabel(/^Where did the money go/), checking.code, label(checking));
    await page.getByRole('button', { name: 'Record and new' }).click();
    await expect(page.getByText('Payment recorded · $75.00')).toBeVisible();
    await expect(page).toHaveURL(/\/payments\/new$/);
    await expect(page.getByLabel(/^Date/)).toHaveValue('2026-06-15');
    await expect(page.getByLabel(/^Method/)).toHaveValue('check');
    await expect(page.getByLabel(/^Where did the money go/)).toHaveValue(label(checking));
    await expect(page.getByLabel(/^Amount/)).toHaveValue('');
    await expect(page.getByLabel(/^Customer/)).toHaveValue('');

    // A fresh form remembers the method and deposit account for this company.
    await gotoReady(page, '/payments/new');
    await expect(page.getByLabel(/^Method/)).toHaveValue('check');
    await expect(page.getByLabel(/^Where did the money go/)).toHaveValue(label(checking));

    const list = await apiGet<{ items: { amount: string; method: string; date: string }[] }>(page, `/api/payments?contactId=${a.id}&limit=5`);
    expect(list.items).toEqual([expect.objectContaining({ amount: '75.00', method: 'check', date: '2026-06-15' })]);
  });
});
