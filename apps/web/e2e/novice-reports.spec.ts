import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, BankAccountDto, BankTransactionDto, CompanyDto, JournalEntryDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, unique } from './helpers';

/**
 * Plain-language reports and accountant tools (docs/novice-ux-plan.md 0.4, 0.5, 1.4, 2.2):
 * the unreviewed-lines banner, Schedule C's uncategorized call-out, tax lines on
 * categories, and plain copy on the index, balance sheet, journal and history.
 * Other specs share the database, so nothing here depends on global counts.
 */

interface PendingReview {
  count: number;
}

/** A bank account to put test lines on: an existing one, or a new one with its own ledger account. */
async function someBankAccount(page: Page): Promise<BankAccountDto> {
  const list = await apiGet<BankAccountDto[] | { items: BankAccountDto[] }>(page, '/api/banking/accounts');
  const items = Array.isArray(list) ? list : list.items;
  const bank = items.find((b) => b.kind === 'bank');
  if (bank) return bank;
  const code = `10${Date.now().toString().slice(-3)}`;
  return apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: unique('Novice checking'), kind: 'bank', newLedgerAccount: { code, name: unique('Novice checking') } });
}

/** A date no other spec uses, so the period holds only this run's lines. */
function lonelyDate(): string {
  const n = Date.now();
  const month = String((n % 12) + 1).padStart(2, '0');
  const day = String(((n >> 4) % 28) + 1).padStart(2, '0');
  return `2031-${month}-${day}`;
}

test.describe('Novice reports', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
  });

  test('reports index speaks plainly and calls the transactions report All activity', async ({ page }) => {
    await gotoReady(page, '/reports');
    await expect(page.getByRole('main')).not.toContainText(/posted entries|settlement recognition/i);
    const list = page.getByRole('list', { name: 'Available reports' });
    await expect(list.getByRole('link', { name: /Profit & Loss.*Am I making money\?/ })).toBeVisible();
    await expect(list.getByRole('link', { name: /Trial balance.*For your accountant/ })).toBeVisible();
    await expect(list.getByRole('link', { name: /All activity/ })).toHaveAttribute('href', /^\/reports\/transactions/);
    await expect(list.getByRole('link', { name: /^Transactions/ })).toHaveCount(0);

    await gotoReady(page, '/reports/transactions?from=2026-01-01&to=2026-01-31');
    await expect(page.getByRole('heading', { level: 1, name: 'All activity' })).toBeVisible();
  });

  test('reports warn about bank transactions still waiting for review', async ({ page }) => {
    const bank = await someBankAccount(page);
    const date = lonelyDate();
    const line = await apiPost<BankTransactionDto>(page, '/api/banking/transactions', { bankAccountId: bank.id, date, amount: '-12.34', description: unique('Unreviewed coffee') });
    const expected = await apiGet<PendingReview>(page, `/api/reports/unreviewed?from=${date}&to=${date}`);
    expect(expected.count).toBeGreaterThanOrEqual(1);

    await gotoReady(page, `/reports/profit-and-loss?from=${date}&to=${date}&basis=cash`);
    const banner = page.getByTestId('pending-review-banner');
    await expect(banner).toContainText(`${expected.count} bank ${expected.count === 1 ? 'transaction' : 'transactions'} from this period`);
    await expect(banner).toContainText('in this report yet');
    await expect(banner.getByRole('link', { name: /Review (it|them)/ })).toHaveAttribute('href', `/banking/inbox?from=${date}&to=${date}`);

    await gotoReady(page, `/reports/category?from=${date}&to=${date}`);
    await expect(page.getByTestId('pending-review-banner')).toBeVisible();

    // As-of reports count everything up to the date.
    await gotoReady(page, `/reports/balance-sheet?asOf=${date}`);
    await expect(page.getByTestId('pending-review-banner')).toContainText('dated on or before');

    // Reviewing the line (here: excluding it) makes it go away.
    await apiPost(page, `/api/banking/transactions/${line.id}/exclude`, { version: line.version, reason: 'Test line' });
    const after = await apiGet<PendingReview>(page, `/api/reports/unreviewed?from=${date}&to=${date}`);
    expect(after.count).toBe(expected.count - 1);
    await gotoReady(page, `/reports/profit-and-loss?from=${date}&to=${date}&basis=cash`);
    await expect(page.getByTestId('pnl-net-income').or(page.getByText('No activity in this period'))).toBeVisible();
    if (after.count === 0) await expect(page.getByTestId('pending-review-banner')).toHaveCount(0);
  });

  test('balance sheet explains its sections and hides a zero difference', async ({ page }) => {
    await gotoReady(page, '/reports/balance-sheet?asOf=2026-12-31');
    await expect(page.getByTestId('report-note')).toContainText('Dec 31, 2026');
    await expect(page.getByTestId('report-note')).not.toContainText('2026-12-31');
    const table = page.getByRole('table', { name: 'Balance sheet' });
    await expect(table.getByRole('button', { name: 'What the business has' })).toBeVisible();
    await expect(table.getByRole('button', { name: 'What the business owes' })).toBeVisible();
    await expect(table.getByText('Profit this year so far')).toBeVisible();
    await expect(table.getByText('Profit from earlier years')).toBeVisible();
    await expect(page.getByTestId('bs-difference')).toHaveCount(0);
    // Tap-to-open explanation names the accounting term too.
    await table.getByRole('button', { name: 'What the business has' }).click();
    await expect(page.getByRole('dialog', { name: 'What the business has' })).toContainText('Accountants call this assets.');
  });

  test('basis toggle explains cash and accrual', async ({ page }) => {
    await gotoReady(page, '/reports/profit-and-loss?from=2026-01-01&to=2026-01-31&basis=accrual');
    const group = page.getByRole('group', { name: 'Basis' });
    await expect(group.getByRole('button', { name: 'Cash' })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'What does basis mean?' }).click();
    await expect(page.getByRole('dialog', { name: 'Cash or accrual' })).toContainText('Most sole proprietors file taxes on cash.');
    await page.keyboard.press('Escape');
    await group.getByRole('button', { name: 'Cash' }).click();
    await expect(page).toHaveURL(/basis=cash/);
    await expect(page.getByTestId('pnl-note')).toContainText('when customers paid you');
  });

  test('Schedule C calls out uncategorized money and its line', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.beta.orgId, orgRole: 'org:admin' });
    const { company } = await apiGet<{ company: CompanyDto }>(page, '/api/session');
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const uncategorized = accounts.find((a) => a.role === 'uncategorized_expense')!;
    const bank = accounts.find((a) => a.code === '1000')!;
    await apiPost<JournalEntryDto>(page, '/api/journal', {
      date: '2025-03-14',
      memo: unique('Mystery charge'),
      cashTreatment: 'include',
      post: true,
      lines: [
        { accountId: uncategorized.id, debit: '1.23' },
        { accountId: bank.id, credit: '1.23' },
      ],
    });
    await gotoReady(page, '/reports/schedule-c?taxYear=2025&basis=cash');
    const callout = page.getByTestId('schedule-c-uncategorized');
    await expect(callout).toContainText('of spending hasn’t been sorted into a category yet.');
    // The line comes from the 2025 mapping; companies created in a later year may have none for 2025.
    await expect(callout).toContainText(/line 27b \(Other expenses\) until you categorize it|isn’t on any line until you categorize it/);
    await expect(callout.getByRole('link', { name: 'See what’s in it' })).toHaveAttribute('href', new RegExp(`accountId=${uncategorized.id}&from=2025-01-01&to=2025-12-31`));
    if (!company.businessType || company.businessType === 'sole_proprietor' || company.businessType === 'single_member_llc') {
      await expect(page.getByTestId('schedule-c-not-your-form')).toHaveCount(0);
    }
  });

  test('new categories get a tax-form line and the chart shows it', async ({ page }) => {
    const { company } = await apiGet<{ company: CompanyDto }>(page, '/api/session');
    test.skip(!!company.businessType && company.businessType !== 'sole_proprietor' && company.businessType !== 'single_member_llc', 'Schedule C does not apply to this business type');
    await gotoReady(page, '/accounts');
    await expect(page.getByRole('heading', { level: 1, name: 'Chart of accounts' })).toBeVisible();
    // Starter accounts explain themselves; roles wait behind Show details.
    await expect(page.getByText('Money you took out of the business for yourself.').first()).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Role' })).toHaveCount(0);
    // The toggle lives in the URL, so it flips once the navigation lands.
    await page.getByLabel('Show details').click();
    await expect(page).toHaveURL(/details=1/);
    await expect(page.getByRole('columnheader', { name: 'Role' }).first()).toBeVisible();
    await page.getByLabel('Show details').click();
    await expect(page).not.toHaveURL(/details=1/);

    const name = unique('Postage stamps');
    await page.getByRole('button', { name: 'New account' }).click();
    const dialog = page.getByRole('dialog', { name: 'New account' });
    await dialog.getByLabel('Type').selectOption('expense');
    await expect(dialog.getByText('Expense: something you spend money on to run the business.')).toBeVisible();
    await dialog.getByLabel(/^Name/).fill(name);
    const taxLine = dialog.getByLabel('Tax form line');
    await expect(taxLine).toHaveValue('18');
    await expect(dialog.getByText(/Suggested from the name/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Account created')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row.getByTestId('account-tax-line')).toHaveText('Schedule C: line 18 Office expense');

    // Balance-sheet accounts don't ask for one.
    await page.getByRole('button', { name: 'New account' }).click();
    await dialog.getByLabel('Type').selectOption('asset');
    await expect(dialog.getByLabel('Tax form line')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('journal entries speak plainly and link to their source record', async ({ page }) => {
    await gotoReady(page, '/journal');
    await expect(page.getByRole('heading', { level: 1, name: 'Journal entries' })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('Most businesses rarely need these');
    await expect(page.getByRole('table', { name: 'Journal entries' }).getByText('Posted', { exact: true })).toHaveCount(0);

    await gotoReady(page, '/journal/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New journal entry' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'Record expense' })).toHaveAttribute('href', '/purchases/new');
    const cash = page.getByLabel('Count on cash-basis reports?');
    await expect(cash.locator('option')).toHaveText(['Yes', 'No (accrual adjustment)']);

    const invoiceEntries = await apiGet<{ items: JournalEntryDto[] }>(page, '/api/journal?sourceType=invoice&limit=1');
    const entry = invoiceEntries.items[0];
    if (entry?.sourceId) {
      await gotoReady(page, `/journal/${entry.id}`);
      await expect(page.getByTestId('journal-source-link')).toHaveAttribute('href', `/invoices/${entry.sourceId}`);
      await expect(page.getByTestId('journal-source-link')).toHaveText('Invoice');
    }
  });

  test('history shows readable actions and details', async ({ page }) => {
    await gotoReady(page, '/audit');
    await expect(page.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
    const table = page.getByRole('table', { name: 'History' });
    await expect(table).toBeVisible();
    // No raw action codes such as "invoice.issued" in the action column.
    const actions = await table.locator('tbody tr td:nth-child(2)').allInnerTexts();
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.trim()).not.toMatch(/^[a-z_]+\.[a-z_]+$/);
    await expect(table.getByText(/^Teammate /)).toHaveCount(0);
  });

  test('accounting periods say Locked and Lock', async ({ page }) => {
    await gotoReady(page, '/settings/periods');
    await expect(page.getByRole('main')).toContainText('Lock a month or year once you’ve filed');
    await expect(page.getByRole('button', { name: 'Lock period' })).toBeVisible();
    await expect(page.getByRole('main').getByText(/^closed$/)).toHaveCount(0);
  });
});
