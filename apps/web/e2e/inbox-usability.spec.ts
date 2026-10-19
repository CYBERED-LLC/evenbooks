import { test, expect, type Locator, type Page } from '@playwright/test';
import { devLogin, unique, ORGS, apiGet, apiPost, gotoReady, pickOption } from './helpers';

interface BankAccount {
  id: string;
  name: string;
}
interface Batch {
  id: string;
  status: string;
  importedCount: number;
}

/** A fresh bank account with `rows` imported through the API, so every test sees only its own lines. */
async function seedBankAccount(page: Page, rows: string[]) {
  const name = unique('Usability Bank');
  const code = `10${Date.now().toString().slice(-3)}`;
  const bank = await apiPost<BankAccount>(page, '/api/banking/accounts', { name, kind: 'bank', newLedgerAccount: { code, name } });
  const csv = ['Date,Description,Amount', ...rows].join('\n');
  const preview = await apiPost<Batch>(page, '/api/banking/imports', { bankAccountId: bank.id, fileName: 'usability.csv', content: csv });
  const committed = await apiPost<Batch>(page, `/api/banking/imports/${preview.id}/commit`, {});
  expect(committed.importedCount).toBe(rows.length);
  return bank;
}

async function mealsRule(page: Page) {
  const accounts = await apiGet<{ id: string; code: string }[]>(page, '/api/accounts');
  const meals = accounts.find((a) => a.code === '5140')!;
  const token = unique('UX').replace(/\s+/g, '-');
  await apiPost(page, '/api/banking/rules', { name: unique('UX rule'), pattern: token, matchType: 'contains', direction: 'out', accountId: meals.id });
  return token;
}

/** Trigger a request and wait for its response (dev compiles can be slow; toasts are short-lived). */
async function expectPost(page: Page, urlPart: string, act: () => Promise<void>) {
  const waiting = page.waitForResponse((r) => r.url().includes(urlPart) && r.request().method() === 'POST', { timeout: 60_000 });
  await act();
  const res = await waiting;
  expect(res.ok(), `${urlPart} -> ${res.status()} ${await res.text()}`).toBeTruthy();
}

const tab = (page: Page, label: string) => page.getByRole('tab', { name: new RegExp(`^${label}`) });
const toast = (page: Page, text: string | RegExp): Locator => page.getByRole('status').filter({ hasText: text });

test.describe('Inbox usability', () => {
  test('bulk transfer previews payouts, filters accounts, records each deposit and offers undo', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const clearing = await apiPost<{ id: string; code: string; name: string }>(page, '/api/accounts', {
      code: `wave-${Date.now()}`, name: unique('Wave Clearing'), type: 'asset',
    });
    const bank = await seedBankAccount(page, [
      '2026-09-29,WAVE PAYOUT 1,28.38', '2026-09-29,WAVE PAYOUT 2,28.38',
      '2026-09-29,WAVE PAYOUT 3,28.38', '2026-09-29,RETURN TO CLEARING,-10.00',
    ]);
    await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}`);
    for (let i = 1; i <= 3; i++) await page.getByLabel(`Select WAVE PAYOUT ${i}`, { exact: true }).check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await bar.getByRole('button', { name: 'Transfer…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Record 3 transfers' })).toBeVisible();
    await expect(dialog.getByLabel('Transfer totals')).toContainText('$85.14');
    await expect(dialog.getByLabel('Selected transfers').getByRole('listitem')).toHaveCount(3);
    const field = dialog.getByLabel(/^Transfer from/);
    await expect(field).toBeEnabled();
    await dialog.getByRole('button', { name: 'Record 3 transfers' }).click();
    await expect(dialog.getByText('Choose a different account.')).toBeVisible();
    await field.fill(bank.name);
    await expect(dialog.getByRole('option')).toHaveCount(0);
    await field.fill('4100');
    await expect(dialog.getByRole('option')).toHaveCount(0);
    await pickOption(field, clearing.name, `${clearing.code} ${clearing.name}`);
    await expectPost(page, '/api/banking/transactions/bulk', () => dialog.getByRole('button', { name: 'Record 3 transfers' }).click());
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'Recorded 3 transfers')).toBeVisible();
    await expect(tab(page, 'Transfers')).toContainText('3');
    await expect(page.getByTestId('txn-row')).toHaveCount(1);
    await expectPost(page, '/api/banking/transactions/bulk', () => toast(page, 'Recorded 3 transfers').getByRole('button', { name: 'Undo' }).click());
    await expect(page.getByTestId('txn-row')).toHaveCount(4);
    await expect(tab(page, 'Transfers')).toContainText('0');

    // Opposite directions stay visible as separate totals, rather than being netted.
    await page.getByLabel('Select WAVE PAYOUT 1', { exact: true }).check();
    await page.getByLabel('Select RETURN TO CLEARING', { exact: true }).check();
    await bar.getByRole('button', { name: 'Transfer…', exact: true }).click();
    await expect(dialog.getByLabel(/^Other account/)).toBeVisible();
    await expect(dialog.getByLabel('Transfer totals')).toContainText('Money in from this account: $28.38');
    await expect(dialog.getByLabel('Transfer totals')).toContainText('Money out to this account: $10.00');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('bulk accept suggestions, undo from the toast, bulk exclude', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const token = await mealsRule(page);
    const bank = await seedBankAccount(page, [`2026-08-03,${token} LATTE,-5.00`, `2026-08-02,${token} MUFFIN,-3.25`, '2026-08-01,MYSTERY CHARGE,-20.00']);

    await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}`);
    const rows = page.getByTestId('txn-row');
    await expect(rows).toHaveCount(3);
    const summary = page.getByTestId('suggestion-summary');
    await expect(summary).toContainText('2 with suggestions');

    await summary.getByRole('button', { name: 'Select 2 on this page' }).click();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar).toContainText('2 selected');
    await expect(page.getByLabel(`Select ${token} LATTE`)).toBeChecked();
    await expect(page.getByLabel('Select MYSTERY CHARGE')).not.toBeChecked();

    await expectPost(page, '/api/banking/transactions/bulk', () => bar.getByRole('button', { name: 'Accept 2 suggestions' }).click());
    await expect(toast(page, 'Categorized 2 transactions')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(tab(page, 'Categorized')).toContainText('2');
    await expect(bar).toBeHidden();

    // Undo straight from the toast puts both lines back
    await expectPost(page, '/api/banking/transactions/bulk', () => toast(page, 'Categorized 2 transactions').getByRole('button', { name: 'Undo' }).click());
    await expect(toast(page, '2 reviews undone')).toBeVisible();
    await expect(rows).toHaveCount(3);
    await expect(tab(page, 'Categorized')).toContainText('0');

    // Bulk exclude with a one-click reason
    await page.getByLabel('Select MYSTERY CHARGE').check();
    await expect(bar).toContainText('1 selected');
    await expect(bar.getByRole('button', { name: 'Accept 0 suggestions' })).toBeDisabled();
    await bar.getByRole('button', { name: 'Exclude…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Duplicate' }).click();
    await expect(dialog.getByLabel(/^Reason/)).toHaveValue('Duplicate');
    await expectPost(page, '/api/banking/transactions/bulk', () => dialog.getByRole('button', { name: 'Exclude 1' }).click());
    await expect(toast(page, 'Excluded 1 transaction')).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(tab(page, 'Excluded')).toContainText('1');
  });

  test('keyboard review, toast undo, save & next, exclude chips', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const token = await mealsRule(page);
    const bank = await seedBankAccount(page, [`2026-08-22,${token} LATTE,-12.00`, '2026-08-21,OFFICE CHAIR,-250.00', '2026-08-20,CLIENT PAYMENT,913.37']);

    await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}`);
    const rows = page.getByTestId('txn-row');
    await expect(rows).toHaveCount(3);
    await expect(page.getByLabel('Inbox keyboard shortcuts')).toBeVisible();

    // j / k move between rows; x toggles the selection
    await page.keyboard.press('j');
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press('j');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press('x');
    await expect(page.getByLabel(`Select ${token} LATTE`)).toBeChecked();
    await expect(page.getByRole('region', { name: 'Bulk actions' })).toContainText('1 selected');
    await page.keyboard.press('x');
    await expect(page.getByLabel(`Select ${token} LATTE`)).not.toBeChecked();

    // Enter on a row with a suggestion accepts it; the toast offers Undo
    await expectPost(page, '/categorize', () => rows.nth(0).press('Enter'));
    await expect(toast(page, 'Categorized to Meals')).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expectPost(page, '/undo', () => toast(page, 'Categorized to Meals').getByRole('button', { name: 'Undo' }).click());
    await expect(toast(page, 'Review undone')).toBeVisible();
    await expect(rows).toHaveCount(3);

    // Save & next categorizes and opens the following line
    await page.getByRole('button', { name: 'Review OFFICE CHAIR' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Review: OFFICE CHAIR' })).toBeVisible();
    await expect(dialog.getByLabel(/^Category/)).toBeFocused();
    await pickOption(dialog.getByLabel(/^Category/), '5110', '5110 Supplies');
    await expectPost(page, '/categorize', () => dialog.getByRole('button', { name: 'Save & next' }).click());
    await expect(dialog.getByRole('heading', { name: 'Review: CLIENT PAYMENT' })).toBeVisible();
    await expect(dialog.getByText('Money in · $913.37')).toBeVisible();

    // Exclude with a reason chip
    await dialog.getByRole('tab', { name: 'Exclude' }).click();
    await expect(dialog.getByRole('button', { name: 'Personal', exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Bank reversal' }).click();
    await expect(dialog.getByRole('button', { name: 'Bank reversal' })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByLabel(/^Reason/)).toHaveValue('Bank reversal');
    await expectPost(page, '/exclude', () => dialog.getByRole('button', { name: 'Exclude', exact: true }).click());
    await expect(dialog).toBeHidden();
    await expect(toast(page, 'Transaction excluded')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(tab(page, 'Categorized')).toContainText('1');
    await expect(tab(page, 'Excluded')).toContainText('1');

    // e opens the focused row straight on the Exclude tab
    await rows.nth(0).focus();
    await page.keyboard.press('e');
    await expect(dialog.getByRole('tab', { name: 'Exclude' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByLabel(/^Reason/)).toBeFocused();
  });

  test('search by text or amount, amount range, filtered tab counts and footer', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const bank = await seedBankAccount(page, [
      '2026-08-15,HARDWARE STORE,-45.00',
      '2026-08-14,HARDWARE STORE,-1200.50',
      '2026-08-13,GROCERY MART,-45.00',
      '2026-08-12,DEPOSIT,300.00',
    ]);

    await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}`);
    const rows = page.getByTestId('txn-row');
    await expect(rows).toHaveCount(4);
    await expect(tab(page, 'For review')).toContainText('4');
    await expect(page.getByText('4 of 4 transactions')).toBeVisible();

    const search = page.getByLabel('Search transactions');
    await search.fill('HARDWARE');
    await expect(page).toHaveURL(/q=HARDWARE/);
    await expect(rows).toHaveCount(2);
    await expect(tab(page, 'For review')).toContainText('2');
    await expect(page.getByText('2 of 2 transactions')).toBeVisible();

    // A number also matches the amount, money in or out
    await search.fill('45');
    await expect(page).toHaveURL(/q=45/);
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'GROCERY MART' })).toHaveCount(1);
    await search.fill('$1,200.50');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('-$1,200.50');

    await search.fill('');
    await expect(rows).toHaveCount(4);
    const min = page.getByLabel('Minimum amount');
    await min.fill('100');
    await min.press('Enter');
    await expect(page).toHaveURL(/amountMin=100/);
    await expect(rows).toHaveCount(2);
    await expect(tab(page, 'For review')).toContainText('2');
    await expect(page.getByText('At least $100.00')).toBeVisible();

    const max = page.getByLabel('Maximum amount');
    await max.fill('500');
    await max.press('Enter');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('DEPOSIT');
    await expect(page.getByText('1 of 1 transactions')).toBeVisible();
  });
});

test.describe('Rules page usability', () => {
  test('name defaults from the pattern, search, inline toggle, matching link, confirm delete', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    await gotoReady(page, '/settings/rules');
    const token = unique('ZEBRA').replace(/\s+/g, '-');

    await page.getByRole('button', { name: 'New rule' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/^Pattern/)).toBeFocused();
    await dialog.getByLabel(/^Pattern/).fill(`${token} CAFE`);
    await expect(dialog.getByLabel(/^Name/)).toHaveValue(new RegExp(`${token.toLowerCase().replace(/^z/, 'Z')} Cafe`, 'i'));
    await dialog.getByLabel('Direction').selectOption('out');
    await pickOption(dialog.getByLabel(/^Suggest account/), '5140', '5140 Meals');
    // Enter in a field submits the dialog
    await expectPost(page, '/api/banking/rules', () => dialog.getByLabel(/^Pattern/).press('Enter'));
    await expect(toast(page, 'Rule created')).toBeVisible();

    await page.getByLabel('Search rules').fill(token);
    const row = page.getByRole('row').filter({ hasText: `${token} CAFE` });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('link', { name: 'Show matching transactions' })).toHaveAttribute('href', `/banking/inbox?q=${encodeURIComponent(`${token} CAFE`)}`);

    const active = row.getByRole('switch');
    await expect(active).toHaveAttribute('aria-checked', 'true');
    await active.click();
    await expect(toast(page, 'Rule turned off')).toBeVisible();
    await expect(active).toHaveAttribute('aria-checked', 'false');
    await expect(row).toContainText('Inactive');

    await row.getByRole('button', { name: /^Delete rule/ }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm).toContainText('Delete rule?');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(toast(page, 'Rule deleted')).toBeVisible();
    await expect(page.getByText('No rules match')).toBeVisible();
  });
});
