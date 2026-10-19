import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { apiGet, devLogin, gotoReady, ORGS } from './helpers';

/**
 * Reports usability: shared period presets, drill-down into the general ledger,
 * comparison columns, and the Schedule C mappings and opening-balance helpers.
 * Nothing here saves or posts, so the spec is re-runnable on the seeded data.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

test.beforeEach(async ({ page }) => {
  await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
});

test.describe('Reports: shared period', () => {
  test('a preset picked on one report carries to the others and to the index links', async ({ page }) => {
    const now = new Date();
    const from = isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const to = isoDate(new Date(now.getFullYear(), now.getMonth(), 0));

    await gotoReady(page, '/reports/profit-and-loss');
    await page.getByLabel('Period').selectOption({ label: 'Last month' });
    await expect(page).toHaveURL(new RegExp(`from=${from}&to=${to}`));
    await page.getByRole('button', { name: 'Cash' }).click();
    await expect(page).toHaveURL(/basis=cash/);
    await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', /basis=cash/);

    // Trial balance is a snapshot, with no period controls.
    await gotoReady(page, `/reports/trial-balance?asOf=${to}`);
    await expect(page.getByLabel('As of', { exact: true })).toHaveValue(to);
    await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('To', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Period')).toHaveCount(0);

    // The category report also picks up the basis.
    await gotoReady(page, '/reports/category');
    await expect(page.getByLabel('From', { exact: true })).toHaveValue(from);
    await expect(page.getByRole('link', { name: 'Download CSV' })).toHaveAttribute('href', /basis=cash/);

    // Index links carry the period (and the basis where the report has one).
    await gotoReady(page, '/reports');
    const list = page.getByRole('list', { name: 'Available reports' });
    await expect(list.getByRole('link', { name: /Trial balance/ })).toHaveAttribute('href', `/reports/trial-balance?asOf=${to}`);
    await expect(list.getByRole('link', { name: /Profit & Loss/ })).toHaveAttribute('href', new RegExp(`from=${from}&to=${to}.*basis=cash`));
    await expect(list.getByRole('link', { name: /Balance sheet/ })).toHaveAttribute('href', `/reports/balance-sheet?asOf=${to}`);
  });
});

test.describe('Reports: drill-down', () => {
  test('trial balance CSV matches the snapshot and legacy URLs keep their end date', async ({ page }) => {
    const canonical = await apiGet<{ asOf: string; totalDebit: string; totalCredit: string }>(page, '/api/reports/trial-balance?asOf=2026-12-31');
    const legacy = await apiGet(page, '/api/reports/trial-balance?from=2026-12-01&to=2026-12-31');
    expect(legacy).toEqual(canonical);
    expect(canonical.asOf).toBe('2026-12-31');
    await gotoReady(page, '/reports/trial-balance?asOf=2026-12-31');
    const waiting = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download CSV' }).click();
    const download = await waiting;
    expect(download.suggestedFilename()).toBe('trial-balance-2026-12-31.csv');
    const csv = await readFile((await download.path())!, 'utf8');
    expect(csv.split('\r\n')[0]).toBe('Code,Account,Type,Debit,Credit');
    expect(csv.trimEnd().split('\r\n').at(-1)).toBe(`,Total,,${canonical.totalDebit},${canonical.totalCredit}`);
  });

  test('trial balance rows open the full ledger history through the snapshot date', async ({ page }) => {
    await gotoReady(page, '/reports/trial-balance?from=2020-01-01&to=2026-12-31');
    const row = page.getByTestId('tb-row').first();
    await expect(row).toBeVisible();
    const href = await row.getByRole('link').getAttribute('href');
    expect(href).toMatch(/^\/reports\/general-ledger\?accountId=[0-9a-f-]+&from=\d{4}-\d{2}-\d{2}&to=2026-12-31$/);
    const firstEntryDate = new URL(href!, 'http://localhost').searchParams.get('from')!;
    // The whole row is clickable, not just the name.
    await row.locator('td').first().click();
    await expect(page).toHaveURL(/\/reports\/general-ledger\?accountId=/);
    await expect(page.getByTestId('gl-opening')).toBeVisible();
    await expect(page.getByTestId('gl-total-debit')).toBeVisible();
    await expect(page.getByTestId('gl-total-credit')).toBeVisible();
    await expect(page.getByTestId('gl-closing')).toBeVisible();
    await expect(page.getByLabel('From', { exact: true })).toHaveValue(firstEntryDate);
  });

  test('profit and loss account lines link to the general ledger', async ({ page }) => {
    await gotoReady(page, '/reports/profit-and-loss?from=2020-01-01&to=2026-12-31&basis=accrual');
    const rows = page.getByTestId('pnl-income-row').or(page.getByTestId('pnl-expense-row'));
    test.skip((await rows.count()) === 0, 'no P&L activity in the seed');
    const link = rows.first().getByRole('link');
    await expect(link).toHaveAttribute('href', /^\/reports\/general-ledger\?accountId=.+&from=2020-01-01&to=2026-12-31$/);
    await link.click();
    await expect(page.getByTestId('gl-opening')).toBeVisible();
  });
});

test.describe('Reports: comparison', () => {
  test('profit and loss shows prior-period columns', async ({ page }) => {
    await gotoReady(page, '/reports/profit-and-loss?from=2026-04-01&to=2026-06-30&basis=accrual&compare=prev');
    await expect(page.getByLabel('Compare to')).toHaveValue('prev');
    await expect(page.getByTestId('compare-caption')).toContainText('Compared with');
    await expect(page.getByRole('columnheader', { name: 'Prior' }).first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Change' }).first()).toBeVisible();
    await expect(page.getByTestId('pnl-net-income')).toBeVisible();
    // Turning comparison off removes the columns.
    await page.getByLabel('Compare to').selectOption('none');
    await expect(page).not.toHaveURL(/compare=/);
    await expect(page.getByRole('columnheader', { name: 'Prior' })).toHaveCount(0);
  });

  test('balance sheet and category report compare with last year', async ({ page }) => {
    await gotoReady(page, '/reports/balance-sheet?asOf=2026-12-31&compare=yoy');
    await expect(page.getByRole('columnheader', { name: 'Prior' }).first()).toBeVisible();
    await expect(page.getByTestId('bs-difference')).toHaveCount(0);
    expect(await page.getByTestId('cmp-prior').count()).toBeGreaterThan(0);

    await gotoReady(page, '/reports/category?from=2026-01-01&to=2026-12-31&basis=accrual&compare=yoy');
    await expect(page.getByTestId('compare-caption')).toContainText('Compared with');
    expect(await page.getByTestId('cmp-prior').count()).toBeGreaterThan(0);
  });
});

test.describe('Reports: lists', () => {
  test('outstanding invoices filter by aging bucket and group by customer', async ({ page }) => {
    await gotoReady(page, '/reports/outstanding-invoices?asOf=2026-12-31');
    const tile = page.getByRole('button', { name: /Current/ });
    await tile.click();
    await expect(page).toHaveURL(/bucket=current/);
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
    for (const b of await page.getByTestId('oi-row').all()) await expect(b).toHaveAttribute('data-bucket', 'current');
    await page.getByRole('button', { name: /Total outstanding/ }).click();
    await expect(page).not.toHaveURL(/bucket=/);

    await page.getByRole('button', { name: 'By customer' }).click();
    await expect(page).toHaveURL(/group=customer/);
    if ((await page.getByTestId('oi-row').count()) > 0) {
      await expect(page.getByTestId('oi-group').first()).toBeVisible();
      await expect(page.getByTestId('oi-subtotal').first()).toBeVisible();
    }
  });

  test('transactions memo search and totals', async ({ page }) => {
    await gotoReady(page, '/reports/transactions?from=2020-01-01&to=2026-12-31');
    await expect(page.getByTestId('txn-total-debit')).toBeVisible();
    await page.getByLabel('Memo').fill('zz-no-such-memo');
    await expect(page).toHaveURL(/q=zz-no-such-memo/);
    await expect(page.getByTestId('txn-row')).toHaveCount(0);
  });
});

test.describe('Schedule C mappings: filters and bulk assign', () => {
  test('unmapped filter, search, and assigning selected rows (discarded, not saved)', async ({ page }) => {
    await gotoReady(page, '/settings/mappings?year=2026');
    const selects = page.getByRole('combobox', { name: /^Schedule C line for/ });
    await expect(selects.first()).toBeVisible();

    // Search narrows the rows to the typed code.
    const firstLabel = (await selects.first().getAttribute('aria-label'))!;
    const code = firstLabel.replace('Schedule C line for ', '').split(' ')[0]!;
    await page.getByLabel('Search accounts').fill(code);
    for (const row of await page.getByTestId('mapping-row').all()) await expect(row).toContainText(code);
    await page.getByLabel('Search accounts').fill('');

    // Unmapped only: every row left is unmapped.
    await page.getByLabel('Unmapped only').check();
    const shown = await selects.all();
    if (shown.length === 0) await expect(page.getByText('No accounts match')).toBeVisible();
    for (const s of shown) await expect(s).toHaveValue('');
    await page.getByLabel('Unmapped only').uncheck();

    // Select two rows and assign them one line in a single step.
    const rows = page.getByTestId('mapping-row');
    test.skip((await rows.count()) < 2, 'needs two accounts');
    const a = rows.nth(0);
    const b = rows.nth(1);
    const before = [await a.getByRole('combobox').inputValue(), await b.getByRole('combobox').inputValue()];
    const target = ['27b', '22', '18'].find((c) => !before.includes(c))!;
    await a.getByRole('checkbox').check();
    await b.getByRole('checkbox').check();
    await expect(page.getByTestId('mappings-bulk')).toContainText('2 selected');
    await page.getByLabel('Line for selected accounts').selectOption(target);
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(a.getByRole('combobox')).toHaveValue(target);
    await expect(b.getByRole('combobox')).toHaveValue(target);
    await expect(page.getByTestId('mappings-unsaved')).toContainText('2 unsaved changes');
    await expect(page.getByTestId('mappings-bulk')).toHaveCount(0);

    // Copy asks before throwing the edits away; keep editing.
    await page.getByRole('button', { name: /Copy from 2025/ }).click();
    await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByTestId('mappings-unsaved')).toContainText('2 unsaved changes');

    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByTestId('mappings-unsaved')).toHaveCount(0);
    await expect(a.getByRole('combobox')).toHaveValue(before[0]!);
    await expect(b.getByRole('combobox')).toHaveValue(before[1]!);
  });
});

test.describe('Opening balances: paste from a spreadsheet', () => {
  test('pasted rows fill matching accounts and report unknown codes (does not post)', async ({ page }) => {
    await gotoReady(page, '/settings/opening-balances?view=advanced');
    const inputs = page.getByRole('textbox', { name: /^Opening balance for/ });
    test.skip((await inputs.count()) < 2, 'needs two editable accounts');
    const label = async (i: number) => (await inputs.nth(i).getAttribute('aria-label'))!.replace('Opening balance for ', '');
    const [first, second] = [await label(0), await label(1)];
    const code1 = first.split(' ')[0]!;
    const code2 = second.split(' ')[0]!;

    await page.getByRole('button', { name: 'Paste from spreadsheet' }).click();
    const dialog = page.getByRole('dialog', { name: 'Paste from spreadsheet' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Rows').fill(`Code\tAccount\tBalance\n${code1}\tSomething\t$1,000.00\n"${code2}","250.50"\nZZ-404\t5`);
    await dialog.getByRole('button', { name: 'Fill balances' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole('textbox', { name: `Opening balance for ${first}` })).toHaveValue('1,000.00');
    await expect(page.getByRole('textbox', { name: `Opening balance for ${second}` })).toHaveValue('250.50');
    await expect(page.getByTestId('ob-paste-result')).toContainText('Filled 2 accounts');
    await expect(page.getByTestId('ob-paste-unmatched')).toContainText('ZZ-404');
    await expect(page.getByRole('button', { name: 'Save starting balances' })).toBeEnabled();

    // Filters and subtotals.
    await page.getByLabel('Type').selectOption('liability');
    for (const row of await page.getByTestId('ob-row').all()) await expect(row).toContainText(/liability/i);
    await page.getByLabel('Type').selectOption('');

    await page.getByRole('button', { name: 'Clear all amounts' }).click();
    await expect(page.getByTestId('ob-plug')).toHaveText('$0.00');
    await expect(page.getByRole('button', { name: 'Save starting balances' })).toBeDisabled();
  });

  test('offsetting balances show the balanced state', async ({ page }) => {
    await gotoReady(page, '/settings/opening-balances?view=advanced');
    const table = page.getByRole('table', { name: 'Opening balances' });
    await page.getByLabel('Type').selectOption('asset');
    const asset = table.getByRole('textbox', { name: /^Opening balance for/ }).first();
    test.skip((await asset.count()) === 0, 'no editable asset');
    await asset.fill('100');
    await page.getByLabel('Type').selectOption('liability');
    const liability = table.getByRole('textbox', { name: /^Opening balance for/ }).first();
    test.skip((await liability.count()) === 0, 'no editable liability');
    await liability.fill('100');
    await expect(page.getByTestId('ob-balanced')).toContainText('Balanced');
    await expect(page.getByTestId('ob-plug')).toHaveText('$0.00');
    await expect(page.getByTestId('ob-subtotal-liability')).toHaveText('$100.00');
    await page.getByRole('button', { name: 'Clear all amounts' }).click();
  });
});
