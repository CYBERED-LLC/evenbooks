import { test, expect, type Page } from '@playwright/test';
import { devLogin, unique, ORGS, apiGet, apiPost, gotoReady } from './helpers';

type Account = { id: string; code: string; name: string };
type BankAccount = { id: string; name: string; ledgerAccountId: string };
type Detail = { id: string; lines: { journalLineId: string; amount: string; cleared: boolean }[] };

async function post(page: Page, bank: BankAccount, other: Account, date: string, amount: number, memo: string) {
  const abs = String(Math.abs(amount));
  await apiPost(page, '/api/journal', {
    date,
    memo,
    cashTreatment: 'include',
    post: true,
    lines:
      amount > 0
        ? [
            { accountId: bank.ledgerAccountId, debit: abs },
            { accountId: other.id, credit: abs },
          ]
        : [
            { accountId: other.id, debit: abs },
            { accountId: bank.ledgerAccountId, credit: abs },
          ],
  });
}

test.describe('Reconciliation usability', () => {
  test('rapid ticks are batched without losing any, shift-click ticks a range, the difference bar stays in view', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const accounts = await apiGet<Account[]>(page, '/api/accounts');
    const income = accounts.find((a) => a.code === '4900')!;
    const supplies = accounts.find((a) => a.code === '5110')!;
    const bankName = unique('Tick Bank');
    const bank = await apiPost<BankAccount>(page, '/api/banking/accounts', {
      name: bankName,
      kind: 'bank',
      newLedgerAccount: { code: `11${Date.now().toString().slice(-4)}`, name: bankName },
    });
    await post(page, bank, income, '2026-06-02', 500, unique('Deposit A'));
    await post(page, bank, income, '2026-06-05', 200, unique('Deposit B'));
    await post(page, bank, supplies, '2026-06-09', -120, unique('Supplies'));
    await post(page, bank, supplies, '2026-06-14', -30, unique('Stamps'));
    await post(page, bank, supplies, '2026-06-20', -50, unique('Uncleared cheque'));

    // Statement shows everything except the last cheque: 500 + 200 - 120 - 30 = 550
    const rec = await apiPost<Detail>(page, '/api/banking/reconciliations', {
      bankAccountId: bank.id,
      statementStartDate: '2026-06-01',
      statementEndDate: '2026-06-30',
      statementOpeningBalance: '0',
      statementClosingBalance: '550',
    });

    await page.setViewportSize({ width: 1280, height: 520 });
    await gotoReady(page, `/banking/reconcile/${rec.id}`);
    const difference = page.getByTestId('stat-difference');
    await expect(difference).toHaveText('$550.00');
    const boxes = page.getByRole('checkbox', { name: /^On statement: entry #/ });
    await expect(boxes).toHaveCount(5);

    // Three quick ticks: the boxes never lock, and every tick reaches the server
    await boxes.nth(0).click();
    await boxes.nth(1).click();
    await boxes.nth(2).click();
    for (const i of [0, 1, 2]) await expect(boxes.nth(i)).toBeChecked();
    await expect(page.getByTestId('cleared-count')).toHaveText('3 of 5 on statement');
    await expect(difference).toHaveText('-$30.00');
    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    let saved = await apiGet<Detail>(page, `/api/banking/reconciliations/${rec.id}`);
    expect(saved.lines.filter((l) => l.cleared)).toHaveLength(3);

    // The line equal to the difference is highlighted; the others are not
    const matches = page.locator('tr[data-match="true"]');
    await expect(matches).toHaveCount(1);
    await expect(matches).toContainText('Ticking this makes it match the statement');
    await expect(matches).toContainText('-$30.00');

    // Unclear everything, then tick the first and Shift-click the fourth: lines 1-4 clear
    await page.getByRole('button', { name: 'Unmark all' }).click();
    await expect(page.getByTestId('cleared-count')).toHaveText('0 of 5 on statement');
    await boxes.nth(0).click();
    await boxes.nth(3).click({ modifiers: ['Shift'] });
    for (const i of [0, 1, 2, 3]) await expect(boxes.nth(i)).toBeChecked();
    await expect(boxes.nth(4)).not.toBeChecked();
    await expect(difference).toHaveText('$0.00');
    await expect(page.getByTestId('subtotal-deposits')).toHaveText('$700.00');
    await expect(page.getByTestId('subtotal-withdrawals')).toHaveText('-$150.00');

    // The totals bar stays on screen at the bottom of the page
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await expect(difference).toBeInViewport();

    // Sorting by amount
    await page.getByLabel('Sort').selectOption('amount_desc');
    await expect(page.getByRole('row').nth(1)).toContainText('$500.00');
    await page.getByLabel('Sort').selectOption('amount_asc');
    await expect(page.getByRole('row').nth(1)).toContainText('-$120.00');

    // "Add missing transaction" opens a journal entry for this account at the statement end
    const addMissing = page.getByRole('link', { name: 'Add missing transaction' });
    await expect(addMissing).toHaveAttribute('href', new RegExp(`^/journal/new\\?date=2026-06-30&accountId=${bank.ledgerAccountId}$`));

    await expect(page.getByTestId('save-state')).toHaveText('Saved');
    saved = await apiGet<Detail>(page, `/api/banking/reconciliations/${rec.id}`);
    expect(saved.lines.filter((l) => l.cleared)).toHaveLength(4);

    // Completing asks first
    await page.getByRole('button', { name: 'Complete reconciliation' }).click();
    const prompt = page.getByRole('dialog', { name: 'Complete this reconciliation?' });
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('heading', { level: 1 }).getByText('In progress')).toBeVisible();
    await page.getByRole('button', { name: 'Complete reconciliation' }).click();
    await prompt.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 }).getByText('Completed')).toBeVisible();

    // The start form now prefills the next period and opening balance
    await gotoReady(page, `/banking/reconcile?bankAccountId=${bank.id}`);
    await expect(page.getByLabel(/^Statement start/)).toHaveValue('2026-07-01');
    await expect(page.getByLabel(/^Statement end/)).toHaveValue('2026-07-31');
    await expect(page.getByLabel(/^Opening balance/)).toHaveValue('550.00');
  });

  test('bank link dialog defaults to importing with free ledger codes, and syncs straight away', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const connectionName = unique('Link Defaults Bank');
    await apiPost(page, '/api/banking/connections', { name: connectionName, setupToken: `demo-e2e-${Date.now()}-link`, syncIntervalMinutes: 360 });

    await gotoReady(page, '/banking');
    const connection = page.getByTestId('bank-connection').filter({ hasText: connectionName });
    await connection.getByRole('button', { name: 'Link accounts…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Demo Checking: link')).toHaveValue('new');
    await expect(dialog.getByLabel('Demo Visa: link')).toHaveValue('new');
    await expect(dialog.getByLabel('Demo Visa: kind')).toHaveValue('credit_card');

    // Suggested codes are free and distinct
    const accounts = await apiGet<Account[]>(page, '/api/accounts?includeArchived=true');
    const taken = new Set(accounts.map((a) => a.code));
    const checkingCode = await dialog.getByLabel('Demo Checking: ledger account code').inputValue();
    const visaCode = await dialog.getByLabel('Demo Visa: ledger account code').inputValue();
    expect(checkingCode).toMatch(/^\d+$/);
    expect(visaCode).toMatch(/^\d+$/);
    expect(checkingCode).not.toBe(visaCode);
    expect(taken.has(checkingCode)).toBe(false);
    expect(taken.has(visaCode)).toBe(false);

    // Skip all / Import all
    await dialog.getByRole('button', { name: 'Skip all' }).click();
    await expect(dialog.getByRole('button', { name: 'Link accounts', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Import all' }).click();
    const suffix = Date.now().toString().slice(-6);
    await dialog.getByLabel('Demo Checking: bank account name').fill(`Demo Checking ${suffix}`);
    await dialog.getByLabel('Demo Visa: bank account name').fill(`Demo Visa ${suffix}`);
    // Enter in a field submits the dialog
    await dialog.getByLabel('Demo Visa: bank account name').press('Enter');
    await expect(page.getByText('2 accounts linked')).toBeVisible();

    const syncToast = page.getByRole('status').filter({ hasText: 'Sync complete' });
    await expect(syncToast).toBeVisible({ timeout: 30_000 });
    await syncToast.getByRole('button', { name: 'Review transactions' }).click();
    await expect(page).toHaveURL(/\/banking\/inbox/);
  });

  test('CSV import: drop a file, sample values, problem filter, continue later, and the mapping is reused next time', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId });
    const bankName = unique('Csv Bank');
    const bank = await apiPost<BankAccount>(page, '/api/banking/accounts', {
      name: bankName,
      kind: 'bank',
      newLedgerAccount: { code: `12${Date.now().toString().slice(-4)}`, name: bankName },
    });
    const march = ['Posting Day,Merchant Info,Out,In', '2026-03-02,Coffee Roasters,4.50,', '2026-03-03,Client Deposit,,900.00', 'notadate,Broken Row,1.00,'].join('\n');

    await gotoReady(page, `/banking/import?bankAccountId=${bank.id}`);
    // Drag and drop onto the zone
    const dataTransfer = await page.evaluateHandle((text) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'march.csv', { type: 'text/csv' }));
      return dt;
    }, march);
    await page.getByTestId('csv-dropzone').dispatchEvent('drop', { dataTransfer });
    await expect(page.getByRole('heading', { name: /Confirm column mapping/ })).toBeVisible();

    // Headers the detector can't read: map them by hand, helped by the sample values
    await expect(page.getByTestId('map-date-samples')).toContainText('2026-03-02');
    await page.getByLabel(/^Date order/).selectOption('YMD');
    await page.getByLabel(/^Amount format/).selectOption('split');
    await page.getByLabel(/^Money out column/).selectOption('Out');
    await expect(page.getByTestId('map-debit-samples')).toContainText('4.50');
    await page.getByLabel(/^Money in column/).selectOption('In');
    await expect(page.getByTestId('count-import')).toHaveText('2');
    await expect(page.getByTestId('count-error')).toHaveText('1');

    // Only the problem rows
    const rows = page.getByRole('table', { name: 'Preview rows' }).getByRole('row');
    await expect(rows).toHaveCount(4);
    await page.getByLabel('Show').selectOption('problems');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('Broken Row');

    // Leave, then continue the previewed batch from Recent imports
    await gotoReady(page, '/banking');
    await gotoReady(page, `/banking/import?bankAccountId=${bank.id}`);
    await expect(page.getByRole('heading', { name: /Choose a CSV file/ })).toBeVisible();
    await page.getByRole('link', { name: 'Continue importing march.csv' }).click();
    await expect(page.getByRole('heading', { name: /Confirm column mapping/ })).toBeVisible();
    await expect(page.getByLabel(/^Money out column/)).toHaveValue('Out');
    await expect(page.getByLabel(/^Date order/)).toHaveValue('YMD');
    await page.getByRole('button', { name: 'Import 2 transactions' }).click();
    await expect(page).toHaveURL(new RegExp(`/banking/inbox\\?bankAccountId=${bank.id}`));

    // The next file from the same bank opens with that mapping
    const april = ['Posting Day,Merchant Info,Out,In', '2026-04-02,Coffee Roasters,5.00,', '2026-04-04,Landlord,1200.00,'].join('\n');
    await gotoReady(page, `/banking/import?bankAccountId=${bank.id}`);
    await page.getByLabel(/^CSV file/).setInputFiles({ name: 'april.csv', mimeType: 'text/csv', buffer: Buffer.from(april) });
    await expect(page.getByTestId('mapping-reused')).toBeVisible();
    await expect(page.getByLabel(/^Money out column/)).toHaveValue('Out');
    await expect(page.getByTestId('count-import')).toHaveText('2');
    await expect(page.getByTestId('count-error')).toHaveText('0');
  });
});
