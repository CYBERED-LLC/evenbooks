import { test, expect } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto } from '@evenbooks/contracts';
import { devLogin, unique, ORGS, gotoReady, apiGet, apiPost } from './helpers';

test.describe('Navigation and findability', () => {
  test('command palette opens from the keyboard and jumps to a contact', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const name = unique('Palette Pottery');
    const contact = await apiPost<ContactDto>(page, '/api/contacts', { name, isCustomer: true, isVendor: false });

    await gotoReady(page, '/dashboard');
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search and jump' });
    await expect(palette).toBeVisible();
    const input = palette.getByRole('combobox', { name: 'Search pages, actions and records' });
    await expect(input).toBeFocused();

    // Pages match instantly; records arrive after the debounce.
    await input.fill('chart of');
    await expect(palette.getByRole('option', { name: /Chart of accounts/ })).toBeVisible();

    await input.fill(name);
    const option = palette.getByRole('group', { name: 'Customers & vendors' }).getByRole('option', { name: new RegExp(name) });
    await expect(option).toBeVisible();
    // Arrow to the contact (actions and pages may be listed first), then Enter.
    for (let i = 0; i < 20 && (await option.getAttribute('aria-selected')) !== 'true'; i++) await input.press('ArrowDown');
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await input.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/contacts/${contact.id}$`));
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(palette).toBeHidden();

    // Ctrl+K toggles; Escape closes.
    await page.keyboard.press('Control+k');
    await expect(palette).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  });

  test('g-sequences and the shortcut sheet', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    await gotoReady(page, '/dashboard');
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await expect(page).toHaveURL(/\/contacts$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Customers & vendors' })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Customers & vendors' }).first()).toHaveAttribute('aria-current', 'page');

    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page).toHaveURL(/\/invoices/);

    await page.keyboard.press('Shift+?');
    const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(help).toBeVisible();
    await expect(help).toContainText('Go to Customers & vendors');
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
  });

  test('settings pages share a side nav', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    await gotoReady(page, '/settings');
    await expect(page.getByRole('heading', { level: 2, name: 'Books' })).toBeVisible();
    await page.getByRole('link', { name: /Company/ }).filter({ hasText: 'invoice numbering' }).click();
    await expect(page).toHaveURL(/\/settings\/company$/);

    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(nav.getByRole('link', { name: 'Company', exact: true })).toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'Accounting periods' }).click();
    await expect(page).toHaveURL(/\/settings\/periods$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Accounting periods' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Accounting periods' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Company', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'All settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test('dashboard to-do links to draft invoices', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const revenue = accounts.find((a) => a.code === '4100')!;
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Todo Client'), isCustomer: true, isVendor: false });
    await apiPost<InvoiceDto>(page, '/api/invoices', {
      contactId: customer.id,
      issueDate: '2026-09-01',
      lines: [{ description: 'Draft work', quantity: '1', unitPrice: '10', incomeAccountId: revenue.id, taxRateIds: [] }],
    });

    await gotoReady(page, '/dashboard');
    const todo = page.getByTestId('dashboard-todo');
    await expect(todo.getByRole('heading', { name: 'To do' })).toBeVisible();
    const drafts = todo.getByRole('link', { name: /draft invoices? not yet issued/ });
    await expect(drafts).toBeVisible();
    await drafts.click();
    await expect(page).toHaveURL(/\/invoices\?tab=draft/);
  });

  test('contact page shows the balance and activity tabs', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const revenue = accounts.find((a) => a.code === '4100')!;
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Balance Bakery'), isCustomer: true, isVendor: false });
    const draft = await apiPost<InvoiceDto>(page, '/api/invoices', {
      contactId: customer.id,
      issueDate: '2026-09-01',
      lines: [{ description: 'Catering', quantity: '1', unitPrice: '250', incomeAccountId: revenue.id, taxRateIds: [] }],
    });
    const invoice = await apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });

    await gotoReady(page, `/contacts/${customer.id}`);
    const balance = page.getByTestId('contact-balance');
    await expect(balance).toContainText('Owed to you');
    await expect(balance).toContainText('$250.00');
    await expect(balance).toContainText('1 open invoice');

    const tabs = page.getByRole('tablist', { name: 'Activity' });
    await expect(tabs.getByRole('tab', { name: 'Invoices' })).toHaveAttribute('aria-selected', 'true');
    const invoices = page.getByRole('table', { name: 'Contact invoices' });
    await expect(invoices.getByRole('link', { name: invoice.number! })).toBeVisible();

    // Arrow keys move between tabs.
    await tabs.getByRole('tab', { name: 'Invoices' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Payments' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('No payments yet')).toBeVisible();

    await expect(page.getByRole('main').getByRole('link', { name: 'New invoice', exact: true })).toHaveAttribute('href', `/invoices/new?contactId=${customer.id}`);
    await page.getByRole('link', { name: 'Customers & vendors', exact: true }).first().click();
    await expect(page).toHaveURL(/\/contacts(\?|$)/);
  });

  test('chart of accounts filters by text and type', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    await gotoReady(page, '/accounts');
    await expect(page.getByRole('cell', { name: '5110', exact: true })).toBeVisible();

    const filter = page.getByLabel('Filter accounts by code or name');
    await filter.fill('Checking');
    await expect(page.getByRole('cell', { name: '1000', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '5110', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL((url) => url.searchParams.get('q') === 'Checking');

    const types = page.getByRole('group', { name: 'Account type' });
    await types.getByRole('button', { name: /^Expense/ }).click();
    await expect(types.getByRole('button', { name: /^Expense/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('No accounts match')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(filter).toHaveValue('');
    await expect(page.getByRole('cell', { name: '5110', exact: true })).toBeVisible();

    await types.getByRole('button', { name: /^Expense/ }).click();
    await expect(page.getByRole('table', { name: 'Expense accounts' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Asset accounts' })).toHaveCount(0);
    await expect(page).toHaveURL(/type=expense/);
  });

  test('accountant tools fold into Advanced, and system status is for admins', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    await page.addInitScript(() => window.localStorage.removeItem('eb-nav-advanced'));
    await gotoReady(page, '/dashboard');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const toggle = nav.getByRole('button', { name: 'Advanced' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(nav.getByRole('link', { name: 'Journal entries' })).toHaveCount(0);
    await toggle.click();
    await expect(nav.getByRole('link', { name: 'Journal entries' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Chart of accounts' })).toBeVisible();
    await toggle.click();
    await expect(nav.getByRole('link', { name: 'History' })).toHaveCount(0);

    // Inside an Advanced page the group stays open, with the page marked.
    await gotoReady(page, '/journal');
    await expect(nav.getByRole('link', { name: 'Journal entries' })).toHaveAttribute('aria-current', 'page');

    await gotoReady(page, '/settings');
    await expect(page.getByRole('link', { name: /Sync and email status/ })).toBeVisible();
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:member' });
    await gotoReady(page, '/settings');
    await expect(page.getByRole('heading', { level: 2, name: 'Books' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Sync and email status/ })).toHaveCount(0);
  });
});
