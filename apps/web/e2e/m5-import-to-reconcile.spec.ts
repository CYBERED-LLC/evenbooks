import { test, expect } from '@playwright/test';
import { devLogin, gotoReady, unique, ORGS, apiGet, apiPost, pickOption } from './helpers';

/**
 * End-to-end bookkeeping flow across the M2 screens: import a CSV, review the
 * inbox (categorize + transfer), then reconcile the statement to zero.
 */
test('import → review inbox → reconcile to zero discrepancy', async ({ page }) => {
  test.setTimeout(180_000);
  await devLogin(page, { orgId: ORGS.beta.orgId });
  const code = `10${Date.now() % 100000}`;
  const bank = await apiPost<{ id: string; ledgerAccountId: string }>(page, '/api/banking/accounts', { name: unique('Flow Bank'), kind: 'bank', newLedgerAccount: { code, name: unique('Flow Ledger') } });
  const accounts = await apiGet<{ id: string; code: string }[]>(page, '/api/accounts');
  const card = accounts.find((a) => a.code === '2000')!;

  // 1. Import through the wizard
  const csv = ['Date,Description,Amount', '05/02/2026,CLIENT ACH,1500.00', '05/03/2026,OFFICE SUPPLY CO,-120.00', '05/04/2026,PAYMENT TO CARD,-300.00', ''].join('\n');
  await gotoReady(page, `/banking/import?bankAccountId=${bank.id}`);
  await page.locator('input[type="file"]').setInputFiles({ name: 'flow.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText(/will import|3 transactions|Import 3/i).first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /^Import \d+/ }).click();
  await expect(page).toHaveURL(/\/banking\/inbox/);

  // 2. Review: categorize income, categorize expense, transfer the card payment
  await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}&status=unreviewed`);
  const openReview = async (desc: string) => {
    await page.getByRole('button', { name: `Review ${desc}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  };
  let dialog = await openReview('CLIENT ACH');
  // The dialog opens on Match when an unpaid invoice of that amount exists; this one is other income.
  await dialog.getByRole('tab', { name: /Categorize/ }).click();
  await pickOption(dialog.getByLabel(/^Category/), '4900', /^4900 Other Income/);
  await dialog.getByRole('button', { name: 'Categorize', exact: true }).click();
  await expect(dialog).toBeHidden();

  dialog = await openReview('OFFICE SUPPLY CO');
  await pickOption(dialog.getByLabel(/^Category/), '5110', /^5110 Supplies/);
  await dialog.getByRole('button', { name: 'Categorize', exact: true }).click();
  await expect(dialog).toBeHidden();

  dialog = await openReview('PAYMENT TO CARD');
  await dialog.getByRole('tab', { name: /Transfer/ }).click();
  await dialog.locator('input[name="transfer-choice"]').last().check();
  await pickOption(dialog.getByRole('combobox', { name: 'Other account' }), '2000', /^2000 Credit Card/);
  await dialog.getByRole('button', { name: 'Record transfer' }).click();
  await expect(dialog).toBeHidden();

  await gotoReady(page, `/banking/inbox?bankAccountId=${bank.id}&status=unreviewed`);
  await expect(page.getByText(/no transactions|nothing to review|all caught up|No .* match/i).first()).toBeVisible();

  // ledger effect: no double posting, the card liability moved by 300
  const balances = await apiGet<{ id: string; code: string; balance: string }[]>(page, '/api/accounts?withBalances=true');
  const ledger = balances.find((a) => a.id === bank.ledgerAccountId)!;
  expect(Number(ledger.balance).toFixed(2)).toBe('1080.00');
  void card;

  // 3. Reconcile May to the statement closing balance
  await gotoReady(page, `/banking/reconcile?bankAccountId=${bank.id}`);
  await page.getByLabel(/Statement start/).fill('2026-05-01');
  await page.getByLabel(/Statement end/).fill('2026-05-31');
  await page.getByLabel(/Opening balance/).fill('0');
  await page.getByLabel(/Closing balance/).fill('1080.00');
  await page.getByRole('button', { name: /Start reconciliation/ }).click();
  await expect(page).toHaveURL(/\/banking\/reconcile\/[0-9a-f-]{36}/);
  await page.getByRole('button', { name: 'Mark all as on statement', exact: true }).click();
  await expect(page.getByTestId('stat-difference')).toHaveText(/\$0\.00/, { timeout: 15_000 });
  await expect(page.getByTestId('save-state')).toHaveText('Saved');
  await page.getByRole('button', { name: /Complete reconciliation/ }).click();
  await page.getByRole('dialog', { name: 'Complete this reconciliation?' }).getByRole('button', { name: 'Complete', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 }).getByText('Completed')).toBeVisible();
});
