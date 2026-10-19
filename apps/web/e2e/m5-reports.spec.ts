import { test, expect, type Page } from '@playwright/test';
import type { AccountDto } from '@evenbooks/contracts';
import { apiGet, devLogin, gotoReady, ORGS, pickOption } from './helpers';

/**
 * M5: reports, Schedule C mappings and opening balances.
 * The database is seeded; assertions never depend on specific amounts.
 */

async function expectReportShell(page: Page, heading: string, csvPath: string) {
  await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  await expect(page.getByTestId('report-note')).toBeVisible();
  await expect(page.getByTestId('report-note')).not.toBeEmpty();
  const csv = page.getByRole('link', { name: 'Download CSV' });
  await expect(csv).toBeVisible();
  const href = await csv.getAttribute('href');
  expect(href, 'CSV link href').toBeTruthy();
  expect(href!).toContain(csvPath);
  expect(href!).toContain('format=csv');
  expect(csv).toHaveAttribute('download', '');
  // The server-generated CSV really downloads (same cookie session, no header needed).
  const res = await page.request.get(href!);
  expect(res.ok(), `${href} -> ${res.status()}`).toBeTruthy();
  expect(res.headers()['content-type'] ?? '').toContain('text/csv');
}

test.describe('M5: reports', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
  });

  test('reports index links to every report', async ({ page }) => {
    await gotoReady(page, '/reports');
    await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible();
    await expect(page.getByText('Coming soon')).toHaveCount(0);
    const list = page.getByRole('list', { name: 'Available reports' });
    for (const name of ['Profit & Loss', 'Balance sheet', 'Trial balance', 'General ledger', 'Category report', 'Schedule C summary', 'Outstanding invoices', 'All activity']) {
      await expect(list.getByRole('link', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible();
    }
  });

  test('balance sheet renders, balances, and links accounts to the general ledger', async ({ page }) => {
    await gotoReady(page, '/reports/balance-sheet?asOf=2026-12-31');
    await expectReportShell(page, 'Balance sheet', '/api/reports/balance-sheet');
    // The difference row only appears when the books don't balance.
    await expect(page.getByTestId('bs-difference')).toHaveCount(0);
    await expect(page.getByTestId('bs-inconsistent')).toHaveCount(0);
    await expect(page.getByTestId('bs-total-assets')).toBeVisible();
    await expect(page.getByTestId('bs-total-equity')).toBeVisible();
    // Any account row links into the general ledger for the fiscal year to date.
    const firstRow = page.getByTestId('bs-row').first();
    if ((await page.getByTestId('bs-row').count()) > 0) {
      const href = await firstRow.getByRole('link').getAttribute('href');
      expect(href).toMatch(/^\/reports\/general-ledger\?accountId=.+&from=\d{4}-\d{2}-\d{2}&to=2026-12-31$/);
    }
  });

  test('trial balance renders with equal debit and credit totals', async ({ page }) => {
    await gotoReady(page, '/reports/trial-balance?from=2020-01-01&to=2026-12-31');
    await expectReportShell(page, 'Trial balance', '/api/reports/trial-balance');
    const debit = await page.getByTestId('tb-total-debit').textContent();
    const credit = await page.getByTestId('tb-total-credit').textContent();
    expect(debit).toBeTruthy();
    expect(debit).toBe(credit);
    await expect(page.getByTestId('tb-balanced')).toBeVisible();
    await expect(page.getByTestId('tb-unbalanced')).toHaveCount(0);
  });

  test('general ledger renders for an account with opening and closing rows', async ({ page }) => {
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const bank = accounts.find((a) => a.role === 'bank') ?? accounts[0]!;
    await gotoReady(page, '/reports/general-ledger');
    await expect(page.getByRole('heading', { level: 1, name: 'General ledger' })).toBeVisible();
    await expect(page.getByText('Choose an account')).toBeVisible();
    await pickOption(page.getByLabel('Account', { exact: true }), bank.code, `${bank.code} ${bank.name}`);
    await expect(page).toHaveURL(new RegExp(`accountId=${bank.id}`));
    await expectReportShell(page, 'General ledger', '/api/reports/general-ledger');
    await expect(page.getByTestId('gl-opening')).toBeVisible();
    await expect(page.getByTestId('gl-closing')).toBeVisible();
    await expect(page.getByTestId('gl-account-heading')).toContainText(`${bank.code} ${bank.name}`);
  });

  test('category report renders on both bases', async ({ page }) => {
    await gotoReady(page, '/reports/category?from=2026-01-01&to=2026-12-31&basis=accrual');
    await expectReportShell(page, 'Category report', '/api/reports/category');
    await expect(page.getByTestId('cat-net-income')).toBeVisible();
    await page.getByRole('button', { name: 'Cash' }).click();
    await expect(page).toHaveURL(/basis=cash/);
    await expect(page.getByTestId('report-note')).toContainText(/cash/i);
    const csvHref = await page.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    expect(csvHref).toContain('basis=cash');
  });

  test('schedule C summary renders with the caption and mappings link', async ({ page }) => {
    await gotoReady(page, '/reports/schedule-c?taxYear=2026&basis=cash');
    await expectReportShell(page, 'Schedule C summary', '/api/reports/schedule-c');
    await expect(page.getByLabel('Tax year')).toHaveValue('2026');
    await expect(page.getByTestId('schedule-c-caption')).toContainText('not tax advice');
    await expect(page.getByRole('link', { name: 'Choose tax lines' })).toHaveAttribute('href', '/settings/mappings?year=2026');
    // Expand the first line that has accounts, if any.
    const expander = page.getByRole('button', { name: /Show accounts for line/ }).first();
    if ((await expander.count()) > 0) {
      await expander.click();
      await expect(page.getByTestId('sc-account-row').first()).toBeVisible();
    }
  });

  test('transactions report renders with filters', async ({ page }) => {
    await gotoReady(page, '/reports/transactions?from=2020-01-01&to=2026-12-31');
    await expectReportShell(page, 'All activity', '/api/reports/transactions');
    await page.getByLabel('Source').selectOption('invoice');
    await expect(page).toHaveURL(/sourceType=invoice/);
    const csvHref = await page.getByRole('link', { name: 'Download CSV' }).getAttribute('href');
    expect(csvHref).toContain('sourceType=invoice');
  });

  test('outstanding invoices report renders aging tiles', async ({ page }) => {
    await gotoReady(page, '/reports/outstanding-invoices?asOf=2026-12-31');
    await expectReportShell(page, 'Outstanding invoices', '/api/reports/outstanding-invoices');
    await expect(page.getByTestId('oi-total')).toBeVisible();
    for (const b of ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']) await expect(page.getByTestId(`oi-${b}`)).toBeVisible();
  });

  test('dashboard shows outstanding invoices and cash vs accrual cards', async ({ page }) => {
    await gotoReady(page, '/dashboard');
    await expect(page.getByTestId('dashboard-outstanding')).toBeVisible();
    await expect(page.getByTestId('dashboard-outstanding').getByRole('link', { name: 'View report' })).toHaveAttribute('href', '/reports/outstanding-invoices');
    await expect(page.getByTestId('dashboard-cash-vs-accrual')).toBeVisible();
    await expect(page.getByTestId('dashboard-cash-vs-accrual').getByText('Invoiced (accrual)')).toBeVisible();
    await expect(page.getByTestId('dashboard-cash-vs-accrual').getByText('Money received (cash)')).toBeVisible();
  });
});

test.describe('M5: Schedule C mappings', () => {
  test('changing an account mapping persists across reload', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
    await gotoReady(page, '/settings/mappings?year=2026');
    await expect(page.getByRole('heading', { level: 1, name: 'Schedule C mappings' })).toBeVisible();
    await expect(page.getByLabel('Tax year')).toHaveValue('2026');

    const selects = page.getByRole('combobox', { name: /^Schedule C line for/ });
    await expect(selects.first()).toBeVisible();
    const target = selects.first();
    const label = (await target.getAttribute('aria-label'))!;
    const before = await target.inputValue();
    // Pick a different value each run so the spec is re-runnable: alternate between two expense lines.
    const next = before === '18' ? '22' : '18';
    await target.selectOption(next);
    await expect(page.getByTestId('mappings-unsaved')).toContainText('1 unsaved change');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Mappings saved')).toBeVisible();
    await expect(page.getByTestId('mappings-unsaved')).toHaveCount(0);

    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('combobox', { name: label })).toHaveValue(next);
  });

  test('members cannot save mappings', async ({ page }) => {
    await devLogin(page, { userId: 'user_dev_bookkeeper', orgId: ORGS.alpha.orgId, orgRole: 'org:member' });
    await gotoReady(page, '/settings/mappings?year=2026');
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: /^Schedule C line for/ }).first()).toBeDisabled();
  });
});

test.describe('M5: opening balances', () => {
  test('renders the balance-sheet account table with live totals (does not submit)', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
    await gotoReady(page, '/settings/opening-balances?view=advanced');
    await expect(page.getByRole('heading', { level: 1, name: 'Starting balances' })).toBeVisible();
    const table = page.getByRole('table', { name: 'Opening balances' });
    await expect(table).toBeVisible();
    expect(await page.getByTestId('ob-row').count()).toBeGreaterThan(0);
    // Receivables are document-driven and have no input.
    await expect(table.getByText('Enter as documents').first()).toBeVisible();
    await expect(page.getByLabel(/^As of date/)).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);

    const submit = page.getByRole('button', { name: 'Save starting balances' });
    await expect(submit).toBeDisabled();
    const input = page.getByRole('textbox', { name: /^Opening balance for/ }).first();
    await input.fill('1234.56');
    await expect(page.getByTestId('ob-total-debit')).toHaveText(/\$1,234\.56|\$0\.00/);
    await expect(page.getByTestId('ob-plug')).toHaveText('$1,234.56');
    await expect(submit).toBeEnabled();
    // Leave without posting.
    await input.fill('');
    await expect(submit).toBeDisabled();
  });
});
