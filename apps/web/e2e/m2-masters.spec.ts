import { test, expect } from '@playwright/test';
import { devLogin, unique, ORGS, gotoReady, pickOption, menuItem } from './helpers';

test.describe('M2: masters (contacts, tax rates, items)', () => {
  test('create, search, edit and archive a contact', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const name = unique('Acme Widgets');
    const email = `acme-${Date.now().toString(36)}@example.com`;

    await gotoReady(page, '/contacts');
    await expect(page.getByRole('heading', { level: 1, name: 'Customers & vendors' })).toBeVisible();
    await page.getByRole('button', { name: 'New contact' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'New contact' })).toBeVisible();
    await dialog.getByLabel(/^Name/).fill(name);
    await dialog.getByLabel('Vendor').check();
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByLabel('City').fill('Springfield');
    await dialog.getByLabel('State / region').fill('IL');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Contact created')).toBeVisible();

    // Find it through the debounced search box (URL carries q=)
    await page.getByLabel('Search contacts').fill(name);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === name);
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name }) });
    await expect(row).toBeVisible();
    await expect(row.getByText('Customer')).toBeVisible();
    await expect(row.getByText('Vendor')).toBeVisible();

    // Vendor filter still includes it; the customer-only filter with a nonsense query hides it
    await page.getByLabel('Kind').selectOption('vendor');
    await expect(page.getByRole('link', { name })).toBeVisible();
    await page.getByLabel('Kind').selectOption('');

    // Detail page and edit dialog
    await page.getByRole('link', { name }).click();
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(name);
    await expect(page.getByText('Springfield, IL')).toBeVisible();
    await page.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog');
    await expect(edit.getByRole('heading', { name: `Edit ${name}` })).toBeVisible();
    await edit.getByLabel('Phone').fill('555-0100');
    await edit.getByLabel('Notes').fill('Net 30 terms');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Contact updated')).toBeVisible();
    await expect(page.getByText('555-0100')).toBeVisible();
    await expect(page.getByText('Net 30 terms')).toBeVisible();

    // Archive, then confirm it is hidden from the list until "Show archived"
    await (await menuItem(page, 'Archive')).click();
    await expect(page.getByText('Contact archived')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).getByText('Archived')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore' })).toBeVisible();

    await gotoReady(page, `/contacts?q=${encodeURIComponent(name)}`);
    await expect(page.getByText('No contacts match')).toBeVisible();
    await page.getByLabel('Show archived').check();
    await expect(page).toHaveURL(/archived=1/);
    const archivedRow = page.getByRole('row').filter({ has: page.getByRole('link', { name }) });
    await expect(archivedRow).toBeVisible();
    await expect(archivedRow.getByText('Archived')).toBeVisible();

    // Restore from the detail page
    await page.getByRole('link', { name }).click();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Contact restored')).toBeVisible();
    await expect(await menuItem(page, 'Archive')).toBeVisible();
  });

  test('contact dialog requires a name and at least one kind', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    await gotoReady(page, '/contacts');
    await page.getByRole('button', { name: 'New contact' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Customer').uncheck();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Name is required' })).toBeVisible();
    await expect(dialog.getByRole('alert').filter({ hasText: /customer, vendor, or both/ })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('create a tax rate as a percent and an item using it', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const rateName = unique('County tax');

    await gotoReady(page, '/settings/tax-rates');
    await expect(page.getByRole('heading', { level: 1, name: 'Sales tax rates' })).toBeVisible();
    await page.getByRole('button', { name: 'New tax rate' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Name/).fill(rateName);
    // Out-of-range percent is rejected client-side
    await dialog.getByLabel(/^Rate/).fill('100');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText(/percent/);
    await dialog.getByLabel(/^Rate/).fill('8.25');
    await expect(dialog.getByText('Stored as 0.0825')).toBeVisible();
    await dialog.getByLabel('Agency').fill('County Treasurer');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Tax rate created')).toBeVisible();
    const rateRow = page.getByRole('row').filter({ hasText: rateName });
    await expect(rateRow).toBeVisible();
    await expect(rateRow.getByRole('cell', { name: '8.25%' })).toBeVisible();
    await expect(rateRow.getByText('County Treasurer')).toBeVisible();

    // Edit round-trips the percent representation; clicking anywhere on the row opens it
    await rateRow.getByRole('cell', { name: 'County Treasurer' }).click();
    const edit = page.getByRole('dialog', { name: `Edit ${rateName}` });
    await expect(edit.getByLabel(/^Rate/)).toHaveValue('8.25');
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit).toBeHidden();

    // Item that defaults to the new rate
    const itemName = unique('Consulting hour');
    await gotoReady(page, '/settings/items');
    await expect(page.getByRole('heading', { level: 1, name: 'Products and services' })).toBeVisible();
    await page.getByRole('button', { name: 'New item' }).first().click();
    const idialog = page.getByRole('dialog');
    await idialog.getByLabel(/^Name/).fill(itemName);
    await idialog.getByLabel(/^Kind/).selectOption('service');
    await idialog.getByLabel(/^Unit price/).fill('150.00');
    const accountField = idialog.getByLabel(/^Category/);
    // New items start in the main income category
    await expect(accountField).not.toHaveValue('');
    await pickOption(accountField, '4', /^4\d+ /);
    const chosenAccount = await accountField.inputValue();
    await idialog.getByLabel(`${rateName} (8.25%)`).check();
    await idialog.getByLabel('Description').fill('Hourly consulting');
    await idialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('Item created')).toBeVisible();
    const itemRow = page.getByRole('row').filter({ hasText: itemName });
    await expect(itemRow).toBeVisible();
    await expect(itemRow.getByRole('cell', { name: '$150.00' })).toBeVisible();
    await expect(itemRow.getByText(rateName)).toBeVisible();
    await expect(itemRow.getByText(chosenAccount!.trim())).toBeVisible();
    await expect(itemRow.getByText('Service')).toBeVisible();

    // Deactivate asks first, then hides it until "Show inactive"
    await itemRow.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('dialog', { name: `Edit ${itemName}` }).getByRole('button', { name: 'Deactivate' }).click();
    const confirmDeactivate = page.getByRole('dialog', { name: `Deactivate ${itemName}?` });
    await confirmDeactivate.getByRole('button', { name: 'Deactivate' }).click();
    await expect(page.getByText('Item deactivated')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: itemName })).toHaveCount(0);
    await page.getByLabel('Show inactive').check();
    await expect(page.getByRole('row').filter({ hasText: itemName }).getByText('Inactive')).toBeVisible();
  });

  test('members see tax rates read-only', async ({ page }) => {
    await devLogin(page, { userId: 'user_dev_bookkeeper', orgId: ORGS.alpha.orgId, orgRole: 'org:member' });
    await gotoReady(page, '/settings/tax-rates');
    await expect(page.getByRole('heading', { level: 1, name: 'Sales tax rates' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New tax rate' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  });
});
