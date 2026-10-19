import { test, expect } from '@playwright/test';
import type { ContactDto } from '@evenbooks/contracts';
import { apiPost, devLogin, gotoReady, ORGS, unique } from './helpers';

/**
 * The shared form controls from the usability overhaul, exercised on the
 * journal entry form (the reference implementation): searchable account
 * picker, forgiving amounts, date quick picks, the balance helper, the
 * unsaved-changes guard, and a contact picker that searches the server.
 */
test.describe('Usability building blocks', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
  });

  test('account picker: type a code, Enter or Tab picks, Escape backs out', async ({ page }) => {
    await gotoReady(page, '/journal/new');
    const line1 = page.getByLabel('Line 1 account');
    await line1.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await line1.fill('5110');
    await expect(page.getByRole('option', { name: /^5110 Supplies/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(line1).toHaveValue('5110 Supplies');
    await expect(page.getByRole('listbox')).toHaveCount(0);

    // Name search matches a word inside the name; Tab takes the top match and moves on
    const line2 = page.getByLabel('Line 2 account');
    await line2.fill('checking');
    await page.keyboard.press('Tab');
    await expect(line2).toHaveValue('1000 Checking Account');
    await expect(page.getByLabel('Line 2 debit')).toBeFocused();

    // Escape restores the previous choice
    await line1.fill('zzz-no-such-account');
    await expect(page.getByText('No account matches')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(line1).toHaveValue('5110 Supplies');

    // Recently used accounts come first next time
    await gotoReady(page, '/journal/new');
    await page.getByLabel('Line 1 account').click();
    await expect(page.getByRole('listbox').getByText('Recent', { exact: true })).toBeVisible();
  });

  test('new account from the picker is created and selected', async ({ page }) => {
    const name = unique('Picker-made expense');
    await gotoReady(page, '/journal/new');
    const line1 = page.getByLabel('Line 1 account');
    await line1.fill(name);
    await page.getByRole('option', { name: `New account “${name}”` }).click();
    const dialog = page.getByRole('dialog', { name: 'New account' });
    await expect(dialog.getByLabel(/^Name/)).toHaveValue(name);
    await expect(dialog.getByLabel(/^Code/)).not.toHaveValue('');
    await dialog.getByLabel(/^Name/).press('Enter');
    await expect(dialog).toBeHidden();
    await expect(line1).toHaveValue(new RegExp(`${name}$`));
  });

  test('amounts accept symbols and separators; Balance fills the difference', async ({ page }) => {
    await gotoReady(page, '/journal/new');
    const debit = page.getByLabel('Line 1 debit');
    await debit.fill('$1,200.5');
    await debit.blur();
    await expect(debit).toHaveValue('1,200.50');
    await expect(debit).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(/Debits \$1,200\.50/)).toBeVisible();

    await page.getByLabel('Line 2 credit').fill('abc');
    await expect(page.getByLabel('Line 2 credit')).toHaveAttribute('aria-invalid', 'true');
    await page.getByLabel('Line 2 credit').fill('');

    await page.getByRole('button', { name: 'Balance' }).click();
    await expect(page.getByLabel('Line 2 credit')).toHaveValue('1,200.50');
    await expect(page.getByRole('button', { name: 'Balance' })).toHaveCount(0);

    // Date quick picks
    await page.getByRole('button', { name: 'Quick picks' }).click();
    await page.getByRole('menuitem', { name: /^Yesterday/ }).click();
    await expect(page.getByLabel('Date', { exact: true })).not.toHaveValue('');
  });

  test('errors jump to the field; Cmd/Ctrl+Enter submits', async ({ page }) => {
    await gotoReady(page, '/journal/new');
    await page.getByLabel('Line 1 debit').fill('10');
    await page.getByLabel('Line 2 credit').fill('10');
    await page.getByLabel('Line 2 credit').press('ControlOrMeta+Enter');
    await expect(page.getByRole('alert').filter({ hasText: 'Line 1: choose an account.' })).toBeVisible();
    await expect(page.getByLabel('Line 1 account')).toBeFocused();
    await expect(page.getByLabel('Line 1 account')).toHaveAttribute('aria-invalid', 'true');
  });

  test('leaving a form with unsaved changes asks first', async ({ page }) => {
    await gotoReady(page, '/journal/new');
    await page.getByLabel('Memo', { exact: true }).fill('Half-typed entry');
    await page.getByRole('link', { name: 'Invoices' }).first().click();
    const confirm = page.getByRole('dialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page).toHaveURL(/\/journal\/new/);
    await expect(page.getByLabel('Memo', { exact: true })).toHaveValue('Half-typed entry');

    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('dialog', { name: 'Discard unsaved changes?' }).getByRole('button', { name: 'Discard changes' }).click();
    await expect(page).not.toHaveURL(/\/journal\/new/);
  });

  test('post and new keeps the date and clears the lines', async ({ page }) => {
    await gotoReady(page, '/journal/new');
    await page.getByLabel('Date', { exact: true }).fill('2026-04-15');
    await page.getByLabel('Memo', { exact: true }).fill(unique('Batch entry'));
    await page.getByLabel('Line 1 account').fill('5110');
    await page.keyboard.press('Enter');
    await page.getByLabel('Line 1 debit').fill('5');
    await page.getByLabel('Line 2 account').fill('1000');
    await page.keyboard.press('Enter');
    await page.getByLabel('Line 2 credit').fill('5');
    await page.getByRole('button', { name: 'Post and new' }).click();
    await expect(page.getByText(/Posted entry #\d+/)).toBeVisible();
    await expect(page).toHaveURL(/\/journal\/new/);
    await expect(page.getByLabel('Date', { exact: true })).toHaveValue('2026-04-15');
    await expect(page.getByLabel('Line 1 account')).toHaveValue('');
    await expect(page.getByLabel('Memo', { exact: true })).toHaveValue('');
  });

  test('contact picker finds contacts by server search', async ({ page }) => {
    const name = unique('Zephyr Searchable Vendor');
    await apiPost<ContactDto>(page, '/api/contacts', { name, isCustomer: false, isVendor: true });
    await gotoReady(page, '/purchases/new');
    const vendor = page.getByLabel(/^Vendor/);
    await vendor.fill(name.split(' ').slice(-1)[0]!);
    await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
    await expect(vendor).toHaveValue(name);
  });
});
