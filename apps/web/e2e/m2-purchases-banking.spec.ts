import { test, expect } from '@playwright/test';
import type { AccountDto, BankAccountDto } from '@evenbooks/contracts';
import { apiGet, devLogin, gotoReady, ORGS, pickOption, unique, menuItem } from './helpers';

test.describe('M2: purchases and banking', () => {
  test('add a bank account, save and void an expense, import a CSV', async ({ page }) => {
    test.setTimeout(180_000);
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });

    // --- Bank account with a brand-new ledger account -----------------------
    const bankName = unique('Test Checking');
    const ledgerCode = `10${Date.now() % 100000}`;
    const ledgerName = unique('Test Checking Ledger');

    await gotoReady(page, '/banking');
    await page.getByRole('button', { name: 'Add bank account' }).click();
    const addDialog = page.getByRole('dialog');
    await addDialog.getByLabel(/^Name/).fill(bankName);
    await addDialog.getByLabel(/^Type/).selectOption('bank');
    // The chart-of-accounts code and name live under Advanced
    await addDialog.getByText('Advanced', { exact: true }).click();
    await expect(addDialog.getByLabel(/^In the chart of accounts/)).toHaveValue('new');
    // A free code is suggested; the test still picks its own to stay unique
    await expect(addDialog.getByLabel(/^Account code/)).toHaveValue(/^\d+$/);
    await addDialog.getByLabel(/^Account code/).fill(ledgerCode);
    await addDialog.getByLabel(/^Account name in the chart/).fill(ledgerName);
    await addDialog.getByRole('button', { name: 'Add account' }).click();
    await expect(page.getByText('Bank account added')).toBeVisible();
    // No starting balance given: the dialog points to where to enter it
    await expect(addDialog.getByRole('heading', { name: `${bankName} is added` })).toBeVisible();
    await expect(addDialog.getByRole('link', { name: 'Enter its starting balance' })).toHaveAttribute('href', /\/settings\/opening-balances\?accountId=[0-9a-f-]{36}$/);
    await addDialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('table', { name: 'Bank accounts' }).getByText(bankName)).toBeVisible();

    const bankAccounts = await apiGet<BankAccountDto[]>(page, '/api/banking/accounts');
    const bankAccount = bankAccounts.find((b) => b.name === bankName);
    expect(bankAccount, 'bank account exists via API').toBeTruthy();

    // --- Purchase with two lines paid from the new account -------------------
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const expense = accounts.filter((a) => a.type === 'expense' && a.isActive);
    expect(expense.length).toBeGreaterThanOrEqual(2);

    await gotoReady(page, '/purchases/new');
    await page.getByLabel(/^Date/).fill('2026-04-15');
    await pickOption(page.getByLabel(/^Paid from/), ledgerCode, `${ledgerCode} ${ledgerName}`);
    await page.getByLabel(/^Direction/).selectOption('outflow');
    await page.getByLabel('Reference', { exact: true }).fill('RCPT-1');
    await page.getByLabel('Note', { exact: true }).fill(unique('Office supplies run'));
    await pickOption(page.getByLabel('Line 1 category'), expense[0]!.code, `${expense[0]!.code} ${expense[0]!.name}`);
    await page.getByLabel('Line 1 description').fill('Paper');
    await page.getByLabel('Line 1 amount').fill('40.00');
    await page.getByRole('button', { name: 'Add line' }).click();
    await pickOption(page.getByLabel('Line 2 category'), expense[1]!.code, `${expense[1]!.code} ${expense[1]!.name}`);
    await page.getByLabel('Line 2 description').fill('Toner');
    await page.getByLabel('Line 2 amount').fill('12.50');
    await expect(page.getByText('Total $52.50')).toBeVisible();
    await page.getByRole('button', { name: 'Save expense' }).click();

    await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}/);
    await expect(page.getByTestId('purchase-total')).toHaveText('$52.50');
    // A normal expense carries no status badge
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Expense');
    await expect(page.getByRole('link', { name: 'View entry' })).toBeVisible();

    // --- Void it -------------------------------------------------------------
    await (await menuItem(page, 'Void…')).click();
    const voidDialog = page.getByRole('dialog');
    await voidDialog.getByLabel(/^Reason/).fill('Entered twice');
    await voidDialog.getByRole('button', { name: 'Void expense' }).click();
    await expect(page.getByText('Expense voided')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).getByText('Void', { exact: true })).toBeVisible();
    await expect(page.getByText('Reason: “Entered twice”.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'View reversal entry' })).toBeVisible();

    // The list shows it as void
    await gotoReady(page, '/purchases?status=void');
    await expect(page.getByRole('table', { name: 'Expenses' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Expenses' }).getByText('Void', { exact: true }).first()).toBeVisible();

    // --- CSV import wizard ---------------------------------------------------
    const csvText = ['Date,Description,Amount', '01/05/2026,Coffee Shop,-4.50', '01/06/2026,Client deposit,1200.00', '01/07/2026,Office supplies,-35.20'].join('\n');

    await gotoReady(page, `/banking/import?bankAccountId=${bankAccount!.id}`);
    await expect(page.getByLabel(/^Bank account/)).toHaveValue(bankAccount!.id);
    await page.getByLabel(/^CSV file/).setInputFiles({ name: 'test.csv', mimeType: 'text/csv', buffer: Buffer.from(csvText) });

    await expect(page.getByRole('heading', { name: /Confirm column mapping/ })).toBeVisible();
    await expect(page.getByLabel(/^Date column/)).toHaveValue('Date');
    await expect(page.getByLabel(/^Description column/)).toHaveValue('Description');
    await expect(page.getByLabel(/^Amount column/)).toHaveValue('Amount');
    await expect(page.getByTestId('count-import')).toHaveText('3');
    await expect(page.getByTestId('count-duplicate')).toHaveText('0');
    await expect(page.getByTestId('count-error')).toHaveText('0');
    await expect(page.getByRole('table', { name: 'Preview rows' }).getByRole('row')).toHaveCount(4);
    await expect(page.getByRole('cell', { name: 'Coffee Shop' })).toBeVisible();

    // Remapping produces a new batch and keeps the preview in sync
    await page.getByLabel(/^Date order/).selectOption('DMY');
    await expect(page.getByTestId('count-import')).toHaveText('3');
    await page.getByLabel(/^Date order/).selectOption('MDY');
    await expect(page.getByTestId('count-import')).toHaveText('3');

    await page.getByRole('button', { name: 'Import 3 transactions' }).click();
    await expect(page).toHaveURL(new RegExp(`/banking/inbox\\?bankAccountId=${bankAccount!.id}`));

    // Recent imports lists the committed batch
    await gotoReady(page, `/banking/import?bankAccountId=${bankAccount!.id}`);
    // Each remap created a superseded batch, so target the committed one.
    const committed = page.getByRole('list', { name: 'Recent imports' }).getByRole('listitem').filter({ has: page.getByText('Imported', { exact: true }) });
    await expect(committed).toHaveCount(1);
    await expect(committed.getByText('test.csv')).toBeVisible();
    await expect(committed.getByText(/3 imported/)).toBeVisible();
  });
});
