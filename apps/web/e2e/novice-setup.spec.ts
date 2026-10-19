import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, CompanyDto } from '@evenbooks/contracts';
import { apiGet, devLogin, gotoReady } from './helpers';

/**
 * Guided setup for a brand-new company: the "Set up your books" checklist with its inline
 * welcome questions, hiding and showing it again, starting balances as questions, and the
 * plain Team / Sync and email status pages.
 */
const freshOrg = (tag: string) => `org_dev_e2e_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function checklist(page: Page) {
  const list = page.getByTestId('setup-checklist');
  await expect(list).toBeVisible({ timeout: 30_000 });
  return list;
}

test.describe('Guided setup', () => {
  test('welcome questions tick off the first step; the list hides and comes back', async ({ page }) => {
    await devLogin(page, { orgId: freshOrg('setup') });
    await gotoReady(page, '/dashboard');
    const list = await checklist(page);
    await expect(list.getByTestId('setup-progress')).toHaveText('0 of 5 done');
    // A company with no bank accounts is never told it is all caught up.
    await expect(page.getByText('You are all caught up.')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Record expense' })).toHaveAttribute('href', '/purchases/new');
    await expect(page.getByRole('link', { name: 'New journal entry' })).toHaveCount(0);

    // The questions are inline, not a dialog; Save checks every answer.
    const form = list.getByRole('form', { name: 'Tell us about your business' });
    await expect(form.getByLabel('Time zone')).not.toHaveValue('');
    // The same type-to-search dropdown as the rest of the app, not the browser's datalist.
    await form.getByLabel('Time zone').fill('Chicago');
    await page.getByRole('option', { name: /Chicago — Central Time/ }).click();
    await expect(form.getByLabel('Time zone')).toHaveValue('Chicago — Central Time');
    // The start date is asked with the starting balances, where it matters.
    await expect(form.getByLabel(/records start/)).toHaveCount(0);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByText('Choose the kind of business.')).toBeVisible();
    await form.getByRole('radio', { name: /Single-member LLC/ }).check();
    await form.getByRole('radio', { name: /Not sure — use cash/ }).check();
    await form.getByRole('button', { name: 'Save' }).click();

    await expect(list.getByTestId('setup-progress')).toHaveText('1 of 5 done');
    await expect(list.locator('[data-step="about"]')).toHaveAttribute('data-done', 'true');
    await expect(list.locator('[data-step="about"]')).toContainText('Single-member LLC · Cash basis · America/Chicago');
    const company = await apiGet<CompanyDto>(page, '/api/company');
    expect(company).toMatchObject({ businessType: 'single_member_llc', taxBasis: 'cash', booksStartDate: null, timeZone: 'America/Chicago' });

    // The other steps link to where the work happens.
    await expect(list.locator('[data-step="bank"] a')).toHaveAttribute('href', '/banking');
    await expect(list.locator('[data-step="balances"] a')).toHaveAttribute('href', '/settings/opening-balances');
    await expect(list.locator('[data-step="invoice"] a')).toHaveAttribute('href', '/invoices/new');

    // Hide it; Settings → Company brings it back.
    await list.getByRole('button', { name: 'Hide this list' }).click();
    await expect(page.getByTestId('setup-checklist')).toHaveCount(0);
    await expect.poll(async () => (await apiGet<CompanyDto>(page, '/api/company')).setupDismissedAt).not.toBeNull();

    await gotoReady(page, '/settings/company');
    await expect(page.getByRole('heading', { level: 1, name: 'Company' })).toBeVisible();
    // The answers can be changed here too.
    await expect(page.getByRole('radio', { name: /Single-member LLC/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /^Cash/ })).toBeChecked();
    await expect(page.getByLabel(/records start/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Show the setup checklist' }).click();
    await expect(page.getByRole('button', { name: 'Hide the setup checklist' })).toBeVisible();

    await gotoReady(page, '/dashboard');
    await expect((await checklist(page)).getByTestId('setup-progress')).toHaveText('1 of 5 done');
  });

  test('starting balances are asked as questions and tick off their step', async ({ page }) => {
    await devLogin(page, { orgId: freshOrg('balances') });
    // Without a saved start date, balances default to the end of last tax year (January start).
    const year = new Date().getFullYear() - 1;
    const asOf = `Dec 31, ${year}`;
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const checking = accounts.find((a) => a.role === 'bank')!;
    const card = accounts.find((a) => a.role === 'credit_card')!;

    // Linked from adding a bank account: that account's field is focused.
    await gotoReady(page, `/settings/opening-balances?accountId=${checking.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Starting balances' })).toBeVisible();
    const checkingField = page.getByRole('textbox', { name: `${checking.name}: balance on your statement for ${asOf}` });
    await expect(checkingField).toBeFocused({ timeout: 15_000 });
    await expect(page.getByLabel(/^What date are these balances from/)).toHaveValue(`${year}-12-31`);
    // The debit/credit wording stays in Advanced.
    await expect(page.getByText(/natural direction/)).toHaveCount(0);
    await expect(page.getByTestId('ob-total-debit')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Add an unpaid invoice' })).toHaveAttribute('href', '/invoices/new');

    await checkingField.fill('1500');
    await page.getByRole('textbox', { name: `${card.name}: amount owed on ${asOf}` }).fill('300');
    await expect(page.getByTestId('ob-guided-equity')).toHaveText('$1,200.00');

    // Advanced shows the same amounts in the full table.
    await page.getByRole('tab', { name: 'Advanced: all accounts' }).click();
    await expect(page).toHaveURL(/view=advanced/);
    await expect(page.getByRole('table', { name: 'Opening balances' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Paste from spreadsheet' })).toBeVisible();
    await expect(page.getByTestId('ob-total-debit')).toHaveText('$1,500.00');
    await expect(page.getByTestId('ob-plug')).toHaveText('$1,200.00');
    await page.getByRole('tab', { name: 'Step by step' }).click();

    await page.getByRole('button', { name: 'Save starting balances' }).click();
    await expect(page.getByTestId('ob-posted')).toContainText(`Starting balances saved for ${asOf}`);
    // Saving records when the books start (the day after), which adding a bank account uses.
    await expect.poll(async () => (await apiGet<CompanyDto>(page, '/api/company')).booksStartDate).toBe(`${year + 1}-01-01`);

    await gotoReady(page, '/dashboard');
    const list = await checklist(page);
    await expect(list.locator('[data-step="balances"]')).toHaveAttribute('data-done', 'true');
    // Card balances aren't cash: they get their own list.
    await expect(page.getByRole('heading', { name: 'Credit cards (owed)' })).toBeVisible();
  });

  test('Team, plan and system pages speak plainly', async ({ page }) => {
    await devLogin(page, { orgId: freshOrg('team') });
    await gotoReady(page, '/settings/team');
    await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
    await expect(page.getByTestId('team-limit')).toContainText('Your plan is for 1 person.');
    await expect(page.getByText('Team management is available when signed in with Clerk.')).toBeVisible();

    await gotoReady(page, '/settings/billing');
    await expect(page.getByRole('link', { name: 'Invite someone' })).toHaveAttribute('href', '/settings/team');

    await gotoReady(page, '/settings/jobs');
    await expect(page.getByRole('heading', { level: 1, name: 'Sync and email status' })).toBeVisible();
    await expect(page.getByTestId('technical-details')).not.toHaveAttribute('open', /.*/);
    await page.getByTestId('technical-details').getByText('Technical details').click();
    await expect(page.getByTestId('outbox-pending')).toBeVisible();

    await devLogin(page, { userId: 'user_dev_bookkeeper', orgId: freshOrg('member'), orgRole: 'org:member' });
    await gotoReady(page, '/settings/jobs');
    await expect(page.getByText('Only admins can see this page')).toBeVisible();
    // Members can't save setup answers, so they don't get the checklist.
    await gotoReady(page, '/dashboard');
    await expect(page.getByTestId('dashboard-todo')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('setup-checklist')).toHaveCount(0);
  });
});
