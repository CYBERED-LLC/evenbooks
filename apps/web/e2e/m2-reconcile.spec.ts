import { test, expect } from '@playwright/test';
import { devLogin, unique, ORGS, apiGet, apiPost, gotoReady } from './helpers';

type Account = { id: string; code: string; name: string };
type BankAccount = { id: string; name: string; ledgerAccountId: string };

test.describe('M2: bank reconciliation', () => {
  test('start a statement, clear lines until the difference is zero, complete', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });

    // --- seed through the API -------------------------------------------------
    const accounts = await apiGet<Account[]>(page, '/api/accounts');
    const income = accounts.find((a) => a.code === '4900');
    const supplies = accounts.find((a) => a.code === '5110');
    expect(income, 'seed account 4900 exists').toBeTruthy();
    expect(supplies, 'seed account 5110 exists').toBeTruthy();

    const bankName = unique('Reconcile Bank');
    const code = `10${Date.now().toString().slice(-3)}`;
    const bank = await apiPost<BankAccount>(page, '/api/banking/accounts', {
      name: bankName,
      kind: 'bank',
      newLedgerAccount: { code, name: bankName },
    });
    expect(bank.ledgerAccountId).toBeTruthy();

    // +500 deposit, -120 supplies purchase => ledger balance 380 on the bank account
    await apiPost(page, '/api/journal', {
      date: '2026-05-03',
      memo: unique('Client deposit'),
      cashTreatment: 'include',
      post: true,
      lines: [
        { accountId: bank.ledgerAccountId, debit: '500' },
        { accountId: income!.id, credit: '500' },
      ],
    });
    await apiPost(page, '/api/journal', {
      date: '2026-05-12',
      memo: unique('Office supplies'),
      cashTreatment: 'include',
      post: true,
      lines: [
        { accountId: supplies!.id, debit: '120' },
        { accountId: bank.ledgerAccountId, credit: '120' },
      ],
    });

    // --- start the reconciliation in the browser -----------------------------
    await gotoReady(page, `/banking/reconcile?bankAccountId=${bank.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Bank reconciliation' })).toBeVisible();
    await expect(page.getByLabel('Filter by bank account')).toHaveValue(bank.id);
    // The start form follows the list filter
    await expect(page.getByLabel(/^Bank account/)).toHaveValue(bank.id);
    await expect(page.getByText('No reconciliations yet')).toBeVisible();

    await page.getByLabel(/^Statement start/).fill('2026-05-01');
    await page.getByLabel(/^Statement end/).fill('2026-05-31');
    await page.getByLabel(/^Opening balance/).fill('0');
    await page.getByLabel(/^Closing balance/).fill('380.00');
    await page.getByRole('button', { name: 'Start reconciliation' }).click();

    await expect(page).toHaveURL(/\/banking\/reconcile\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(bankName);
    await expect(page.getByRole('heading', { level: 1 }).getByText('In progress')).toBeVisible();

    // Nothing cleared yet: difference equals the closing balance and Complete is locked
    const difference = page.getByTestId('stat-difference');
    await expect(difference).toHaveText('$380.00');
    await expect(page.getByTestId('stat-ledger')).toHaveText('$380.00');
    const completeBtn = page.getByRole('button', { name: 'Complete reconciliation' });
    await expect(completeBtn).toBeDisabled();

    // Clear the two lines one at a time; the totals follow each tick at once and saves are batched
    const boxes = page.getByRole('checkbox', { name: /^On statement: entry #/ });
    await expect(boxes).toHaveCount(2);
    await boxes.nth(0).click();
    await expect(boxes.nth(0)).toBeChecked();
    await expect(difference).toHaveText('-$120.00');
    await boxes.nth(1).click();
    await expect(boxes.nth(1)).toBeChecked();
    await expect(difference).toHaveText('$0.00');
    await expect(page.getByTestId('stat-cleared')).toHaveText('$380.00');

    // Filters are client-side
    await page.getByLabel('Show').selectOption('uncleared');
    await expect(page.getByText('No lines match')).toBeVisible();
    await page.getByLabel('Show').selectOption('all');
    await expect(boxes).toHaveCount(2);

    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    await expect(completeBtn).toBeEnabled();
    await completeBtn.click();
    await page.getByRole('dialog', { name: 'Complete this reconciliation?' }).getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(page.getByText('Reconciliation completed')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).getByText('Completed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reopen…' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete reconciliation' })).toHaveCount(0);
    for (const box of await boxes.all()) await expect(box).toBeDisabled();

    // --- the list shows the completed session --------------------------------
    await gotoReady(page, `/banking/reconcile?bankAccountId=${bank.id}`);
    const row = page.getByRole('row').filter({ hasText: 'May 31, 2026' });
    await expect(row).toHaveCount(1);
    await expect(row.getByText('Completed')).toBeVisible();
    await expect(row.getByRole('cell', { name: '$380.00' })).toBeVisible();

    // A new statement for this account prefills its opening balance from the completed one
    await expect(page.getByLabel(/^Opening balance/)).toHaveValue('380.00');
  });
});
