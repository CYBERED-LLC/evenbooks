import { test, expect } from '@playwright/test';
import { apiGet, devLogin, gotoReady, pickOption } from './helpers';

/**
 * Moving from another app: a new company sees the import prompt, imports a
 * Wave-style general-ledger export (matching and creating accounts), and the
 * history lands in the journal as balanced entries.
 */
test('import accounting history from a Wave export', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString(36);
  await devLogin(page, { orgId: `org_dev_e2e_import_${suffix}` });

  // 1. A brand-new company is pointed at the importer.
  await gotoReady(page, '/dashboard');
  const prompt = page.getByTestId('import-prompt');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole('link', { name: 'Import data' }).click();
  await expect(page).toHaveURL(/\/settings\/import$/);
  await expect(page.getByTestId('import-not-included')).toContainText('Your customer list and unpaid invoices don’t come over yet.');
  await page.getByRole('link', { name: 'Import accounting history' }).click();
  await expect(page).toHaveURL(/\/settings\/import\/ledger$/);

  // 2. Upload a Wave-shaped export.
  const head = 'Transaction ID,Transaction Date,Account Name,Transaction Description,Transaction Line Description,Debit Amount (Two Column Approach),Credit Amount (Two Column Approach)';
  const csv = [
    head,
    'T1,2025-01-03,Cash on Hand,Client payment,,1200.00,',
    'T1,2025-01-03,Consulting Income,Client payment,,,1200.00',
    'T2,2025-01-10,Office Supplies,Staples,,45.10,',
    'T2,2025-01-10,Cash on Hand,Staples,paper,,45.10',
    'T3,2025-01-15,Accounts Receivable,Invoice 12,,500.00,',
    'T3,2025-01-15,Consulting Income,Invoice 12,,,500.00',
    'T4,2025-01-20,Office Supplies,Broken,,10.00,',
    'T4,2025-01-20,Cash on Hand,Broken,,,9.00',
    'T5,2025-01-25,5090 - Office rent,Rent January,,800.00,',
    'T5,2025-01-25,Cash on Hand,Rent January,,,800.00',
    'T6,2025-01-28,Website Hosting,Hosting and launch event,,30.00,',
    'T6,2025-01-28,Marketing Events,Hosting and launch event,,70.00,',
    'T6,2025-01-28,Cash on Hand,Hosting and launch event,,,100.00',
    '',
  ].join('\n');
  await page.locator('input[type="file"]').setInputFiles({ name: 'wave.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('Step 3 · Match accounts')).toBeVisible({ timeout: 30_000 });
  // Wave's columns are recognized, so the column step stays folded until asked for.
  await expect(page.getByTestId('columns-recognized')).toContainText('We recognized a Wave export; columns are set.');
  await expect(page.getByLabel(/^Date column/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Change columns' }).click();
  await expect(page.getByLabel(/^Date column/)).toHaveValue('Transaction Date');
  await expect(page.getByTestId('count-ready')).toHaveText('5');
  await expect(page.getByTestId('count-error')).toHaveText('1');
  await expect(page.getByText('Debits 10.00 do not equal credits 9.00')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import 5 transactions' })).toBeDisabled();

  // The preview can be narrowed to the problem transactions.
  const txTable = page.getByRole('table', { name: 'Transactions to import' });
  await page.getByLabel('Show', { exact: true }).last().selectOption('problems');
  await expect(txTable.getByRole('row')).toHaveCount(2);
  await expect(txTable.getByText('Broken')).toBeVisible();
  await page.getByLabel('Show', { exact: true }).last().selectOption('all');

  // "Accounts Receivable" is left unmatched: the built-in account holds only Evenbooks invoices and isn't offered.
  await expect(page.getByText(/Create a separate receivable account for this/)).toBeVisible();
  const arPicker = page.getByLabel('Accounts Receivable', { exact: true });
  await arPicker.click();
  await arPicker.fill('Receivable');
  await expect(page.getByRole('option', { name: /Evenbooks invoices/ })).toHaveCount(0);
  await arPicker.press('Escape');

  // 3. Match accounts: pick existing ones back to back (pickers stay usable while saving), create the rest.
  await pickOption(page.getByLabel('Cash on Hand', { exact: true }), '1000', /^1000 Checking Account/);
  await pickOption(page.getByLabel('Office Supplies', { exact: true }), '5110', /^5110 Supplies/);
  await expect(page.getByLabel('Cash on Hand', { exact: true })).toHaveValue('1000 Checking Account');

  // A code written into the file's account name matches that account.
  await page.getByRole('button', { name: 'Match 1 by code' }).click();
  await expect(page.getByLabel('5090 - Office rent', { exact: true })).toHaveValue('5090 Rent or Lease');

  const create = async (source: string, code: string) => {
    await page.getByRole('button', { name: `Create a new account for ${source}` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    // A free code is suggested for the guessed type.
    const suggested = await dialog.getByLabel(/^Code/).inputValue();
    expect(suggested).toMatch(/^\d+$/);
    await dialog.getByLabel(/^Code/).fill(code);
    await dialog.getByLabel(/^Code/).press('Enter');
    await expect(dialog).toBeHidden();
    return suggested;
  };
  expect(await create('Consulting Income', '4200')).toBe('4010');
  await create('Accounts Receivable', '1190');

  // The two left are created in one go.
  await page.getByRole('button', { name: 'Create all unmatched (2)' }).click();
  await page.getByRole('dialog', { name: 'Create 2 new accounts?' }).getByRole('button', { name: 'Create accounts' }).click();
  await expect(page.getByText('All 7 accounts in the file are matched.')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Import 5 transactions' })).toBeEnabled();

  // 4. Commit.
  await page.getByRole('button', { name: 'Import 5 transactions' }).click();
  await expect(page.getByText('History imported')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/5 transactions were added to your books/)).toBeVisible();
  await expect(page.getByTestId('import-check').getByRole('link', { name: 'balance sheet' })).toHaveAttribute('href', '/reports/balance-sheet?asOf=2025-01-28');

  const accounts = await apiGet<{ code: string; name: string; type: string; balance: string }[]>(page, '/api/accounts?withBalances=true');
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  const byName = new Map(accounts.map((a) => [a.name, a]));
  expect(byName.get('Website Hosting')).toMatchObject({ type: 'expense', balance: expect.stringMatching(/^30(\.0+)?$/) });
  expect(byName.get('Marketing Events')).toMatchObject({ type: 'expense' });
  expect(Number(byCode.get('5090')!.balance).toFixed(2)).toBe('800.00');
  expect(byCode.get('4200')).toMatchObject({ name: 'Consulting Income', type: 'income' });
  expect(byCode.get('1190')).toMatchObject({ name: 'Accounts Receivable (previous system)', type: 'asset' });
  expect(Number(byCode.get('1000')!.balance).toFixed(2)).toBe('254.90');
  expect(Number(byCode.get('4200')!.balance).toFixed(2)).toBe('1700.00');

  await page.getByRole('link', { name: 'View imported entries' }).click();
  await expect(page).toHaveURL(/\/journal\?sourceType=import/);
  await expect(page.getByRole('button', { name: 'Remove filter: Source: Import' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Journal entries' }).getByText('Invoice 12')).toBeVisible();

  // 5. The hub lists the import, and the dashboard prompt is gone now that books have entries.
  await gotoReady(page, '/settings/import');
  await expect(page.getByRole('list', { name: 'Accounting history imports' }).getByText('wave.csv')).toBeVisible();
  await gotoReady(page, '/dashboard');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('import-prompt')).toHaveCount(0);
});
