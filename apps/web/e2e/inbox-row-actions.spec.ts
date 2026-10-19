import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, BankAccountDto, BankTransactionDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady } from './helpers';

/** A checking account with one line for review and one categorized line. */
async function seed(page: Page) {
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const bank = await apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: 'Checking', kind: 'bank', ledgerAccountId: accounts.find((a) => a.code === '1000')!.id });
  const open = await apiPost<BankTransactionDto>(page, '/api/banking/transactions', { bankAccountId: bank.id, date: '2026-09-28', amount: '-12.50', description: 'DUPLICATE COFFEE' });
  const done = await apiPost<BankTransactionDto>(page, '/api/banking/transactions', { bankAccountId: bank.id, date: '2026-09-29', amount: '-28.38', description: 'WAVE FINANCIAL' });
  await apiPost(page, `/api/banking/transactions/${done.id}/categorize`, { version: done.version, lines: [{ accountId: accounts.find((a) => a.code === '5140')!.id, amount: '28.38', description: '' }] });
  return { open, done };
}

async function confirmDelete(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Delete bank transaction permanently' });
  await dialog.getByLabel(/^Reason/).fill('Imported twice');
  await dialog.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(dialog).toBeHidden();
}

test.describe('Bank inbox rows', () => {
  test.beforeEach(async ({ page }) => {
    const orgId = `org_dev_e2e_inboxrow_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await devLogin(page, { orgId, orgRole: 'org:admin' });
  });

  test('rows have no Undo or Delete; a reviewed row opens its own dialog for both', async ({ page }) => {
    await seed(page);
    await gotoReady(page, '/banking/inbox?status=categorized');
    const rows = page.getByTestId('txn-row');
    const row = rows.filter({ hasText: 'WAVE FINANCIAL' });
    await expect(row.getByRole('button', { name: /Undo|Delete/ })).toHaveCount(0);
    await expect(row.getByRole('link', { name: 'Journal entry' })).toBeVisible();

    await row.click();
    const dialog = page.getByRole('dialog', { name: 'WAVE FINANCIAL' });
    await expect(dialog).toContainText('Categorized');
    await expect(dialog.getByRole('link', { name: 'Journal entry' })).toHaveAttribute('href', /\/journal\/[0-9a-f-]{36}/);
    await dialog.getByRole('button', { name: 'Delete…' }).click();
    await confirmDelete(page);
    await expect(dialog).toBeHidden();
    await expect(rows.filter({ hasText: 'WAVE FINANCIAL' })).toHaveCount(0);
  });

  test('a line for review is deleted from its review dialog', async ({ page }) => {
    await seed(page);
    await gotoReady(page, '/banking/inbox');
    const rows = page.getByTestId('txn-row');
    const row = rows.filter({ hasText: 'DUPLICATE COFFEE' });
    await expect(row.getByRole('button', { name: /Delete/ })).toHaveCount(0);
    await row.click();
    const review = page.getByRole('dialog', { name: 'Review: DUPLICATE COFFEE' });
    await review.getByRole('button', { name: 'Delete…' }).click();
    await confirmDelete(page);
    await expect(review).toBeHidden();
    await expect(rows.filter({ hasText: 'DUPLICATE COFFEE' })).toHaveCount(0);
  });

  test('on a phone the table fits the screen, with the date under the description', async ({ page }) => {
    await seed(page);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const status of ['unreviewed', 'categorized']) {
      await gotoReady(page, `/banking/inbox?status=${status}`);
      await expect(page.getByTestId('txn-row').first()).toBeVisible();
      expect(await page.getByRole('table', { name: 'Bank transactions' }).evaluate((t) => t.scrollWidth <= t.parentElement!.clientWidth)).toBe(true);
    }
    await expect(page.getByTestId('txn-row').first()).toContainText('Sep 29, 2026');
  });
});
