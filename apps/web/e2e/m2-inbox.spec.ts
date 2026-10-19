import { test, expect, type Page } from '@playwright/test';
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

/** Create a bank account and import transactions through the API. */
async function seedBankAccount(page: Page, rows = ['2026-08-03,COFFEE,-4.50', '2026-08-04,DEPOSIT,1200', '2026-08-05,TRANSFER TO VISA,-300']) {
  const name = unique('Inbox Test Bank');
  const code = `10${Date.now().toString().slice(-3)}`;
  const bank = await apiPost<BankAccount>(page, '/api/banking/accounts', { name, kind: 'bank', newLedgerAccount: { code, name } });
  const csv = ['Date,Description,Amount', ...rows].join('\n');
  const preview = await apiPost<Batch>(page, '/api/banking/imports', { bankAccountId: bank.id, fileName: 'inbox-test.csv', content: csv });
  const committed = await apiPost<Batch>(page, `/api/banking/imports/${preview.id}/commit`, {});
  expect(committed.status).toBe('committed');
  expect(committed.importedCount).toBe(rows.length);
  return bank;
}

const tabCount = (page: Page, label: string) => page.getByRole('tab', { name: new RegExp(`^${label}`) });

/**
 * Click a button that fires a POST and wait for the server to answer before asserting UI state.
 * Dev-mode route compilation can be slow, and success toasts only live for a few seconds.
 */
async function submit(page: Page, button: ReturnType<Page['getByRole']>, urlPart: string) {
  const waiting = page.waitForResponse((r) => r.url().includes(urlPart) && r.request().method() === 'POST', { timeout: 60_000 });
  await button.click();
  const res = await waiting;
  expect(res.ok(), `${urlPart} -> ${res.status()} ${await res.text()}`).toBeTruthy();
}

test.describe('M2: bank transaction review inbox', () => {
  test('review imported transactions: categorize, exclude, undo', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const bank = await seedBankAccount(page);

    await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Bank transactions' })).toBeVisible();
    await expect(tabCount(page, 'For review')).toHaveAttribute('aria-selected', 'true');
    await expect(tabCount(page, 'For review')).toContainText('3');

    const rows = page.getByTestId('txn-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'COFFEE' })).toContainText('-$4.50');
    await expect(rows.filter({ hasText: 'DEPOSIT' })).toContainText('$1,200.00');
    await expect(rows.filter({ hasText: 'TRANSFER TO VISA' })).toContainText('-$300.00');
    await expect(page.getByRole('cell', { name: bank.name }).first()).toBeVisible();

    // Categorize the coffee purchase to Meals through the Review dialog
    await page.getByRole('button', { name: 'Review COFFEE' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Review: COFFEE' })).toBeVisible();
    await expect(dialog.getByText('Money out · $4.50')).toBeVisible();
    await pickOption(dialog.getByLabel(/^Category/), '5140', '5140 Meals');
    await submit(page, dialog.getByRole('button', { name: 'Categorize', exact: true }), '/categorize');
    await expect(page.getByText('Transaction categorized')).toBeVisible();
    await expect(rows).toHaveCount(2);
    await expect(tabCount(page, 'For review')).toContainText('2');
    await expect(tabCount(page, 'Categorized')).toContainText('1');

    await tabCount(page, 'Categorized').click();
    await expect(page).toHaveURL(/status=categorized/);
    await expect(page).toHaveURL(new RegExp(`bankAccountId=${bank.id}`));
    const coffeeRow = rows.filter({ hasText: 'COFFEE' });
    await expect(coffeeRow).toHaveCount(1);
    await expect(coffeeRow.getByText('Categorized')).toBeVisible();
    await expect(coffeeRow.getByRole('link', { name: 'Journal entry' })).toHaveAttribute('href', /\/journal\/[0-9a-f-]{36}/);

    // Categorize the deposit to Other Income (income accounts are offered for money in)
    await tabCount(page, 'For review').click();
    await page.getByRole('button', { name: 'Review DEPOSIT' }).click();
    // (opens on Match instead when some unpaid invoice is for exactly $1,200)
    await dialog.getByRole('tab', { name: /^Categorize/ }).click();
    await expect(dialog.getByText('Money in · $1,200.00')).toBeVisible();
    await pickOption(dialog.getByLabel(/^Category/), '4900', '4900 Other Income');
    await submit(page, dialog.getByRole('button', { name: 'Categorize', exact: true }), '/categorize');
    await expect(page.getByText('Transaction categorized')).toBeVisible();
    await expect(rows).toHaveCount(1);

    // Exclude the transfer with a reason
    await page.getByRole('button', { name: 'Review TRANSFER TO VISA' }).click();
    await dialog.getByRole('tab', { name: 'Exclude' }).click();
    await dialog.getByLabel(/^Reason/).fill('Personal card payment, not a business expense');
    await submit(page, dialog.getByRole('button', { name: 'Exclude', exact: true }), '/exclude');
    await expect(page.getByText('Transaction excluded')).toBeVisible();
    await expect(tabCount(page, 'Excluded')).toContainText('1');
    await expect(page.getByText('All caught up')).toBeVisible();

    await tabCount(page, 'Excluded').click();
    const transferRow = rows.filter({ hasText: 'TRANSFER TO VISA' });
    await expect(transferRow).toContainText('Excluded: Personal card payment');

    // Undo the exclusion from the line's own dialog (no Undo or Delete on the row): back to For review
    await expect(transferRow.getByRole('button', { name: /Undo|Delete/ })).toHaveCount(0);
    await transferRow.click();
    await expect(dialog.getByRole('heading', { name: 'TRANSFER TO VISA' })).toBeVisible();
    await expect(dialog).toContainText('Personal card payment');
    await submit(page, dialog.getByRole('button', { name: 'Undo review' }), '/undo');
    await expect(page.getByText('Review undone')).toBeVisible();
    await expect(tabCount(page, 'Excluded')).toContainText('0');
    await expect(tabCount(page, 'For review')).toContainText('1');
    await tabCount(page, 'For review').click();
    await expect(rows.filter({ hasText: 'TRANSFER TO VISA' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review TRANSFER TO VISA' })).toBeVisible();
  });

  test('create a categorization rule in settings', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    await gotoReady(page, '/settings/rules');
    await expect(page.getByRole('heading', { level: 1, name: 'Categorization rules' })).toBeVisible();
    await expect(page.getByText('Rules only suggest an account; every imported transaction is still reviewed before posting.').first()).toBeVisible();

    const name = unique('Coffee shops');
    await page.getByRole('button', { name: 'New rule' }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Name/).fill(name);
    await dialog.getByLabel('Match type').selectOption('contains');
    await dialog.getByLabel(/^Pattern/).fill('COFFEE');
    await dialog.getByLabel('Direction').selectOption('out');
    await pickOption(dialog.getByLabel(/^Suggest account/), '5140', '5140 Meals');
    await submit(page, dialog.getByRole('button', { name: 'Create rule' }), '/api/banking/rules');
    await expect(page.getByText('Rule created')).toBeVisible();

    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Description contains');
    await expect(row).toContainText('COFFEE');
    await expect(row).toContainText('Money out');
    await expect(row).toContainText('Meals');
  });

  test('rule suggestions, transfers to another of my accounts, and splits', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const accounts = await apiGet<{ id: string; code: string }[]>(page, '/api/accounts');
    const meals = accounts.find((a) => a.code === '5140')!;
    const token = unique('RULETEST').replace(/\s+/g, '-');
    await apiPost(page, '/api/banking/rules', { name: unique('Latte rule'), pattern: token, matchType: 'contains', direction: 'out', accountId: meals.id });
    const bank = await seedBankAccount(page, [`2026-08-10,${token} LATTE,-12.00`, '2026-08-11,CARD PAYMENT,-300', '2026-08-12,SUPPLIES AND MEALS,-100']);

    await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}`);
    const rows = page.getByTestId('txn-row');
    await expect(rows).toHaveCount(3);

    // The rule suggests Meals inline; accepting categorizes without opening the dialog
    const latte = rows.filter({ hasText: 'LATTE' });
    await expect(latte).toContainText('Suggested: Meals');
    await submit(page, latte.getByRole('button', { name: /^Accept suggestion Meals/ }), '/categorize');
    await expect(page.getByText('Categorized to Meals')).toBeVisible();
    await expect(rows).toHaveCount(2);

    // Transfer to a ledger account when the other side is not imported
    await page.getByRole('button', { name: 'Review CARD PAYMENT' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Transfer' }).click();
    await expect(dialog.getByRole('radio', { name: /One of my other accounts/ })).toBeChecked();
    await pickOption(dialog.getByLabel('Other account', { exact: true }), '2000', '2000 Credit Card');
    await submit(page, dialog.getByRole('button', { name: 'Record transfer' }), '/transfer');
    await expect(page.getByText('Transfer recorded')).toBeVisible();
    await expect(tabCount(page, 'Transfers')).toContainText('1');
    await expect(rows).toHaveCount(1);

    // Split one line across two accounts; the remaining amount must reach zero
    await page.getByRole('button', { name: 'Review SUPPLIES AND MEALS' }).click();
    await dialog.getByLabel('Split').check();
    await pickOption(dialog.getByLabel('Split 1 category'), '5110', '5110 Supplies');
    await dialog.getByLabel('Split 1 amount').fill('60');
    await expect(dialog.getByText('Remaining $40.00')).toBeVisible();
    await dialog.getByRole('button', { name: 'Categorize', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Add at least two split lines');
    await pickOption(dialog.getByLabel('Split 2 category'), '5140', '5140 Meals');
    await dialog.getByLabel('Split 2 amount').fill('40');
    await expect(dialog.getByText('Remaining $0.00')).toBeVisible();
    await submit(page, dialog.getByRole('button', { name: 'Categorize', exact: true }), '/categorize');
    await expect(page.getByText('Transaction categorized')).toBeVisible();
    await expect(page.getByText('All caught up')).toBeVisible();
    await expect(tabCount(page, 'Categorized')).toContainText('2');

    // Search filter is reflected in the URL
    await tabCount(page, 'Categorized').click();
    await page.getByLabel('Search transactions').fill('LATTE');
    await expect(page).toHaveURL(/q=LATTE/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('LATTE');
  });
});
