import { test, expect } from '@playwright/test';
import { devLogin, switchOrg, unique, ORGS, apiGet, gotoReady, pickOption, menuItem } from './helpers';

test.describe('M1: tenancy and ledger', () => {
  test('dev login lands on the dashboard for the chosen company', async ({ page }) => {
    await gotoReady(page, '/dev-login');
    await expect(page.getByRole('heading', { name: 'Development sign-in' })).toBeVisible();
    await page.getByLabel('Company').selectOption(ORGS.alpha.orgId);
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { level: 1, name: ORGS.alpha.name })).toBeVisible();
  });

  test('create an account, post a journal entry, reverse it', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const accountName = unique('Conference fees');
    const code = `59${Date.now().toString().slice(-5)}`;

    await gotoReady(page, '/accounts');
    await page.getByRole('button', { name: 'New account' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Code').fill(code);
    await dialog.getByLabel('Type').selectOption('expense');
    await dialog.getByLabel(/^Name/).fill(accountName);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Account created')).toBeVisible();
    // The name cell also carries the account's description and Schedule C line.
    await expect(page.getByRole('cell', { name: new RegExp(`^${accountName}`) })).toBeVisible();

    const memo = unique('Paid conference by check');
    await gotoReady(page, '/journal/new');
    await page.getByLabel('Date').fill('2026-04-10');
    await page.getByLabel('Memo', { exact: true }).fill(memo);
    await pickOption(page.getByLabel("Line 1 account"), code, `${code} ${accountName}`);
    await page.getByLabel('Line 1 debit').fill('250.00');
    await pickOption(page.getByLabel('Line 2 account'), '1000 Checking Account');
    await page.getByLabel('Line 2 credit').fill('250.00');
    await expect(page.getByText('Out of balance')).toHaveCount(0);
    await page.getByRole('button', { name: 'Post entry' }).click();

    await expect(page).toHaveURL(/\/journal\/[0-9a-f-]{36}/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Entry #\d+/);
    // Saved entries are the norm, so only drafts get a badge.
    await expect(page.getByRole('heading', { level: 1 }).getByText('Draft')).toHaveCount(0);
    await expect(page.getByRole('cell', { name: '$250.00' }).first()).toBeVisible();

    // Reverse with a reason
    await (await menuItem(page, 'Reverse…')).click();
    const rdialog = page.getByRole('dialog');
    await rdialog.getByLabel('Reversal date').fill('2026-04-11');
    await rdialog.getByLabel(/^Reason/).fill('Duplicate entry');
    await rdialog.getByRole('button', { name: 'Post reversal' }).click();
    await expect(page.getByText(/Posted reversal #\d+/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).getByText('Reversal')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Original entry' })).toBeVisible();

    // The journal list shows both, and the original is marked reversed
    await gotoReady(page, `/journal?q=${encodeURIComponent(memo)}`);
    await expect(page.getByRole('link', { name: memo })).toBeVisible();
    await expect(page.getByText('Reversed', { exact: true })).toBeVisible();
  });

  test('switching company never shows the other company data', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const memo = unique('Alpha-only entry');
    await gotoReady(page, '/journal/new');
    await page.getByLabel('Date').fill('2026-04-12');
    await page.getByLabel('Memo', { exact: true }).fill(memo);
    await pickOption(page.getByLabel('Line 1 account'), '5110 Supplies');
    await page.getByLabel('Line 1 debit').fill('12.34');
    await pickOption(page.getByLabel('Line 2 account'), '1000 Checking Account');
    await page.getByLabel('Line 2 credit').fill('12.34');
    await page.getByRole('button', { name: 'Post entry' }).click();
    await expect(page).toHaveURL(/\/journal\/[0-9a-f-]{36}/);
    const alphaEntryUrl = page.url();

    // Switch via the sidebar select (dev switcher)
    await gotoReady(page, '/dashboard');
    await page.getByLabel('Switch company').selectOption(ORGS.beta.orgId);
    await expect(page.getByRole('heading', { level: 1, name: ORGS.beta.name })).toBeVisible();
    await expect(page.getByRole('main').getByText(ORGS.alpha.name)).toHaveCount(0);

    await gotoReady(page, `/journal?q=${encodeURIComponent(memo)}`);
    await expect(page.getByText('No journal entries match')).toBeVisible();

    // Direct access to Alpha's entry from Beta is a 404 through the API and the page shows the error
    const session = await apiGet<{ company: { id: string; name: string } }>(page, '/api/session');
    expect(session.company.name).toBe(ORGS.beta.name);
    const res = await page.request.get(alphaEntryUrl.replace(/.*\/journal\//, '/api/journal/'), { headers: { 'x-company-id': session.company.id } });
    expect(res.status()).toBe(404);

    // A stale tab still carrying Alpha's company id is rejected
    const alphaSession = await (async () => {
      await switchOrg(page, ORGS.alpha.orgId);
      const s = await apiGet<{ company: { id: string } }>(page, '/api/session');
      await switchOrg(page, ORGS.beta.orgId);
      return s;
    })();
    const stale = await page.request.get('/api/accounts', { headers: { 'x-company-id': alphaSession.company.id } });
    expect(stale.status()).toBe(409);
  });

  test('members cannot change company settings or periods', async ({ page }) => {
    await devLogin(page, { userId: 'user_dev_bookkeeper', orgId: ORGS.alpha.orgId, orgRole: 'org:member' });
    await gotoReady(page, '/settings/periods');
    await expect(page.getByRole('heading', { name: 'Accounting periods' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lock period' })).toHaveCount(0);
    const session = await apiGet<{ company: { id: string } }>(page, '/api/session');
    const res = await page.request.post('/api/periods', {
      headers: { 'x-company-id': session.company.id },
      data: { startDate: '2020-01-01', endDate: '2020-12-31' },
    });
    expect(res.status()).toBe(403);
  });

  test('locking a period blocks posting and shows in History', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.beta.orgId });
    await gotoReady(page, '/settings/periods');
    // pick a year that no previous run has closed for this company
    const year = 1900 + (Date.now() % 90);
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    await page.getByLabel('Start date').fill(start);
    await page.getByLabel('End date').fill(end);
    await page.getByLabel(/^Reason/).fill('Year finalized');
    await page.getByRole('button', { name: 'Lock period' }).click();
    // Locking asks for confirmation and repeats the range being locked.
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toContainText(String(year));
    await confirmDialog.getByRole('button', { name: 'Lock period' }).click();
    await expect(page.getByText('Period locked').first()).toBeVisible();
    await expect(page.getByRole('table', { name: 'Accounting periods' }).getByText('Locked', { exact: true }).first()).toBeVisible();

    await gotoReady(page, '/journal/new');
    await page.getByLabel('Date').fill(`${year}-06-15`);
    await page.getByLabel('Memo', { exact: true }).fill(unique('Late entry'));
    await pickOption(page.getByLabel('Line 1 account'), '5110 Supplies');
    await page.getByLabel('Line 1 debit').fill('1.00');
    await pickOption(page.getByLabel('Line 2 account'), '1000 Checking Account');
    await page.getByLabel('Line 2 credit').fill('1.00');
    await page.getByRole('button', { name: 'Post entry' }).click();
    await expect(page.getByRole('alert').filter({ hasText: /locked/i })).toBeVisible();
    await expect(page).toHaveURL(/\/journal\/new/);

    await gotoReady(page, '/settings/periods');
    await page.getByRole('button', { name: 'Reopen…' }).first().click();
    await page.getByRole('dialog').getByLabel(/^Reason/).fill('Need an adjustment');
    await page.getByRole('dialog').getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByText('Period reopened')).toBeVisible();

    await gotoReady(page, '/audit?');
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
    await expect(page.getByText('Reopened period').first()).toBeVisible();
    await expect(page.getByText('period.reopened')).toHaveCount(0);
  });
});
