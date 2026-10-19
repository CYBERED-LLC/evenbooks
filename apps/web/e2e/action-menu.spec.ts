import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, menuItem } from './helpers';

async function issuedInvoice(page: Page) {
  const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: 'Menu Test Customer', isCustomer: true });
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const income = accounts.find((a) => a.code === '4100')!;
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', { contactId: customer.id, issueDate: '2026-06-01', lines: [{ description: 'Work', quantity: '1', unitPrice: '300', incomeAccountId: income.id, taxRateIds: [] }] });
  const inv = await apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
  return { inv, accounts };
}

test.describe('Record action menu', () => {
  test.beforeEach(async ({ page }) => {
    const orgId = `org_dev_e2e_menu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await devLogin(page, { orgId, orgRole: 'org:admin' });
  });

  test('an issued invoice shows three actions and keeps the rest in the menu', async ({ page }) => {
    const { inv } = await issuedInvoice(page);
    await gotoReady(page, `/invoices/${inv.id}`);
    const header = page.getByRole('main').locator('div.mb-6').first();
    await expect(header.getByRole('link', { name: 'Record payment' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Send…' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'Download PDF' })).toBeVisible();
    for (const gone of ['Void…', 'Delete…', 'Duplicate', 'Create credit note', 'Make recurring', 'Public link', 'Edit payment URL']) {
      await expect(header.getByRole('button', { name: gone, exact: true })).toHaveCount(0);
      await expect(header.getByRole('link', { name: gone, exact: true })).toHaveCount(0);
    }
    // Nothing paid yet, so the totals skip the zero "Paid" row.
    await expect(page.getByText('Paid', { exact: true })).toHaveCount(0);

    // Keyboard: ↓ opens on the first item, End/↑ move, a letter jumps, Esc returns focus.
    const trigger = page.getByRole('button', { name: 'More actions' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitem', { name: /^Delete…/ })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('m');
    await expect(menu.getByRole('menuitem', { name: /^Make recurring/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Choosing a dialog action opens it; closing it returns focus to the trigger.
    await (await menuItem(page, /^Void…/)).click();
    const voidDialog = page.getByRole('dialog', { name: 'Void invoice' });
    await expect(voidDialog).toBeVisible();
    await voidDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(trigger).toBeFocused();

    // Payment URL is edited where it is shown.
    await page.getByRole('button', { name: 'Edit payment URL' }).click();
    await expect(page.getByRole('dialog', { name: 'Edit payment URL' })).toBeVisible();
  });

  test('a disabled action explains itself in the menu', async ({ page }) => {
    const { inv, accounts } = await issuedInvoice(page);
    await apiPost(page, '/api/payments', { contactId: inv.contactId, date: '2026-06-05', amount: '100', method: 'check', depositAccountId: accounts.find((a) => a.code === '1000')!.id, allocations: [{ invoiceId: inv.id, amount: '100' }] });
    await gotoReady(page, `/invoices/${inv.id}`);
    const voidItem = await menuItem(page, /^Void…/);
    await expect(voidItem).toBeDisabled();
    await expect(voidItem).toContainText('$100.00 has been paid toward it');
    await voidItem.click({ force: true });
    await expect(page.getByRole('dialog', { name: 'Void invoice' })).toHaveCount(0);
    await expect(page.getByRole('menu')).toBeVisible();
  });
});
