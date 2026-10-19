import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, pickOption, unique, menuItem } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

async function incomeAccount(page: Page): Promise<AccountDto> {
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const income = accounts.find((a) => a.type === 'income' && a.isActive);
  expect(income).toBeTruthy();
  return income!;
}

async function issuedInvoice(page: Page, contactId: string, accountId: string, description = 'Design work', issueDate = '2026-06-01'): Promise<InvoiceDto> {
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', {
    contactId,
    issueDate,
    termsDays: 14,
    lines: [{ description, quantity: '3', unitPrice: '40.00', incomeAccountId: accountId, taxRateIds: [] }],
    memo: 'Copied memo',
  });
  return apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version, idempotencyKey: `e2e-issue-${draft.id}` });
}

test.describe('Sales usability', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
  });

  test('invoice page: duplicate, credit note and make recurring start prefilled', async ({ page }) => {
    test.setTimeout(180_000);
    const customerName = unique('Dup Customer');
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true });
    const income = await incomeAccount(page);
    const inv = await issuedInvoice(page, customer.id, income.id);

    // Duplicate: a new draft with the same customer, lines and memo, dated today
    await gotoReady(page, `/invoices/${inv.id}`);
    await expect(page.getByRole('main').getByRole('link', { name: 'Invoices', exact: true })).toBeVisible();
    await (await menuItem(page, 'Duplicate')).click();
    await expect(page).toHaveURL(new RegExp(`/invoices/new\\?copyFrom=${inv.id}`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`copy of ${inv.number}`);
    await expect(page.getByLabel(/^Customer/)).toHaveValue(customerName);
    await expect(page.getByLabel('Line 1 description')).toHaveValue('Design work');
    await expect(page.getByLabel('Memo', { exact: true })).toHaveValue('Copied memo');
    await expect(page.getByLabel(/^Issue date/)).toHaveValue(today());
    await expect(page.getByTestId('doc-total')).toHaveText('$120.00');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    expect(page.url()).not.toContain(inv.id);
    await expect(page.getByRole('heading', { level: 1 }).getByText('draft')).toBeVisible();

    // Create credit note: customer and invoice preselected
    await gotoReady(page, `/invoices/${inv.id}`);
    await (await menuItem(page, 'Create credit note')).click();
    await expect(page).toHaveURL(new RegExp(`/credit-notes/new\\?invoiceId=${inv.id}`));
    await expect(page.getByLabel(/^Customer/)).toHaveValue(customerName);
    await expect(page.getByLabel('For invoice')).toHaveValue(inv.id);

    // Make recurring: the invoice is chosen, name and first invoice date are suggested
    await gotoReady(page, `/invoices/${inv.id}`);
    await (await menuItem(page, 'Make recurring')).click();
    await expect(page).toHaveURL(new RegExp(`/recurring/new\\?invoiceId=${inv.id}`));
    await expect(page.getByLabel('Repeat an existing invoice')).toBeChecked();
    await expect(page.getByLabel(/^Invoice to repeat/)).toHaveValue(new RegExp(inv.number!));
    await expect(page.getByLabel(/^Name/)).toHaveValue(`${customerName} monthly`);
    const anchor = await page.getByLabel(/^First invoice date/).inputValue();
    expect(anchor >= today()).toBe(true);
    await expect(page.getByLabel(/^Days to pay/)).toHaveValue('14');
    await page.getByRole('button', { name: 'Create schedule' }).click();
    await expect(page).toHaveURL(/\/recurring\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`${customerName} monthly`);
  });

  test('issue and new keeps the dates and terms and clears the rest', async ({ page }) => {
    test.setTimeout(120_000);
    const customerName = unique('Batch Customer');
    await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true });
    const income = await incomeAccount(page);

    await gotoReady(page, '/invoices/new');
    await expect(page.getByLabel(/^Customer/)).toBeFocused();
    await pickOption(page.getByLabel(/^Customer/), customerName);
    await page.getByLabel(/^Issue date/).fill('2026-06-10');
    await page.getByLabel(/^Days to pay/).fill('15');
    await expect(page.getByTestId('computed-due')).toContainText('Due');
    await page.getByLabel('Line 1 description').fill('Batch one');
    await page.getByLabel('Line 1 unit price').fill('1,250');
    await pickOption(page.getByLabel('Line 1 category'), income.code, `${income.code} ${income.name}`);
    await expect(page.getByTestId('doc-total')).toHaveText('$1,250.00');

    await page.getByRole('button', { name: 'Issue and new' }).click();
    await expect(page.getByText(/Invoice INV-\S+ issued/)).toBeVisible();
    await expect(page).toHaveURL(/\/invoices\/new$/);
    await expect(page.getByLabel(/^Customer/)).toHaveValue('');
    await expect(page.getByLabel('Line 1 description')).toHaveValue('');
    await expect(page.getByLabel(/^Issue date/)).toHaveValue('2026-06-10');
    await expect(page.getByLabel(/^Days to pay/)).toHaveValue('15');

    // Validation marks the missing customer and focuses it (the success toast sits over the footer)
    await page.getByRole('status').filter({ hasText: /issued/ }).getByRole('button', { name: 'Dismiss' }).click();
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.getByLabel(/^Customer/)).toBeFocused();
    await expect(page.getByRole('main').getByRole('alert')).toContainText('Choose a customer');
  });

  test('line editor: Enter adds a line that copies the account, duplicate and reorder', async ({ page }) => {
    test.setTimeout(120_000);
    const income = await incomeAccount(page);
    await gotoReady(page, '/invoices/new');
    await page.getByLabel('Line 1 description').fill('Alpha');
    await pickOption(page.getByLabel('Line 1 category'), income.code, `${income.code} ${income.name}`);
    await page.getByLabel('Line 1 unit price').fill('10');
    await page.getByLabel('Line 1 unit price').press('Enter');
    await expect(page.getByLabel('Line 2 description')).toBeVisible();
    await expect(page.getByLabel('Line 2 category')).toHaveValue(`${income.code} ${income.name}`);
    await page.getByLabel('Line 2 description').fill('Bravo');
    await page.getByLabel('Line 2 unit price').fill('20');

    await page.getByRole('button', { name: 'Duplicate line 1' }).click();
    await expect(page.getByLabel('Line 2 description')).toHaveValue('Alpha');
    await expect(page.getByLabel('Line 3 description')).toHaveValue('Bravo');
    await page.getByRole('button', { name: 'Move line 3 up' }).click();
    await expect(page.getByLabel('Line 2 description')).toHaveValue('Bravo');
    await expect(page.getByLabel('Line 3 description')).toHaveValue('Alpha');
    await expect(page.getByTestId('doc-subtotal')).toHaveText('$40.00');
    await page.getByRole('button', { name: 'Remove line 3' }).click();
    await expect(page.getByLabel('Line 3 description')).toHaveCount(0);
    await expect(page.getByTestId('doc-subtotal')).toHaveText('$30.00');
  });

  test('deleting a draft asks first', async ({ page }) => {
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Delete Customer'), isCustomer: true });
    const income = await incomeAccount(page);
    const draft = await apiPost<InvoiceDto>(page, '/api/invoices', {
      contactId: customer.id,
      issueDate: '2026-06-01',
      termsDays: 30,
      lines: [{ description: 'Throwaway', quantity: '1', unitPrice: '1.00', incomeAccountId: income.id, taxRateIds: [] }],
    });
    await gotoReady(page, `/invoices/${draft.id}`);
    await (await menuItem(page, 'Delete draft')).click();
    const confirm = page.getByRole('dialog', { name: 'Delete this draft invoice?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(page).toHaveURL(new RegExp(draft.id));
    await (await menuItem(page, 'Delete draft')).click();
    await confirm.getByRole('button', { name: 'Delete draft' }).click();
    await expect(page.getByText('Draft deleted')).toBeVisible();
    await expect(page).toHaveURL(/\/invoices$/);
  });

  test('invoice list: customer chip, paging back and forth, page balance', async ({ page }) => {
    test.setTimeout(120_000);
    const customerName = unique('Paging Customer');
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true });
    const income = await incomeAccount(page);
    await issuedInvoice(page, customer.id, income.id, 'First', '2026-06-01');
    await issuedInvoice(page, customer.id, income.id, 'Second', '2026-06-02');

    await gotoReady(page, `/invoices?contactId=${customer.id}&limit=1`);
    await expect(page.getByText(`Customer: ${customerName}`)).toBeVisible();
    const table = page.getByRole('table', { name: 'Invoices' });
    await expect(table.getByRole('row')).toHaveCount(2); // header + 1
    await expect(page.getByTestId('page-balance-due')).toHaveText('$120.00 due on this page');
    const firstNumber = await table.getByRole('link').first().textContent();
    await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(table.getByRole('link').first()).not.toHaveText(firstNumber!);
    await page.getByRole('button', { name: 'Previous' }).click();
    await expect(table.getByRole('link').first()).toHaveText(firstNumber!);

    // The whole row opens the invoice
    await table.getByRole('row').nth(1).getByRole('cell').nth(2).click(); // customer cell (0 is the checkbox)
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    // …and the back link returns to the filtered list
    await page.getByRole('main').getByRole('link', { name: 'Invoices', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`contactId=${customer.id}`));

    await page.getByRole('button', { name: `Remove filter: Customer: ${customerName}` }).click();
    await expect(page).not.toHaveURL(/contactId=/);
    await expect(page.getByText(`Customer: ${customerName}`)).toHaveCount(0);
  });

  test('items: search, create and add another, confirm before deactivating', async ({ page }) => {
    test.setTimeout(120_000);
    const base = unique('Widget');
    await gotoReady(page, '/settings/items');
    await page.getByRole('button', { name: 'New item' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New item' });
    await dialog.getByLabel(/^Name/).fill(`${base} A`);
    await dialog.getByLabel(/^Unit price/).fill('$1,200.5');
    await pickOption(dialog.getByLabel(/^Category/), '4', /^4\d+ /);
    await dialog.getByRole('button', { name: 'Create and add another' }).click();
    await expect(page.getByText('Item created').first()).toBeVisible();
    await expect(dialog.getByLabel(/^Name/)).toHaveValue('');
    await expect(dialog.getByLabel(/^Name/)).toBeFocused();
    await expect(dialog.getByLabel(/^Category/)).not.toHaveValue('');
    await dialog.getByLabel(/^Name/).fill(`${base} B`);
    await dialog.getByLabel(/^Unit price/).fill('5');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.getByLabel('Search items').fill(base);
    const rows = page.getByRole('table', { name: 'Products and services' }).getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: `${base} A` }).getByRole('cell', { name: '$1,200.50' })).toBeVisible();

    // Clicking the row opens it; deactivating asks first
    await rows.filter({ hasText: `${base} B` }).getByRole('cell', { name: '$5.00' }).click();
    const edit = page.getByRole('dialog', { name: `Edit ${base} B` });
    await edit.getByRole('button', { name: 'Deactivate' }).click();
    const confirm = page.getByRole('dialog', { name: `Deactivate ${base} B?` });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(edit).toBeVisible();
    await edit.getByRole('button', { name: 'Deactivate' }).click();
    await confirm.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByText('Item deactivated')).toBeVisible();
    await expect(rows).toHaveCount(2);
  });
});
