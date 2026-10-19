import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, BankAccountDto, BankConnectionDto, BankTransactionDto, PurchaseDto, ReconciliationDetailDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, unique } from './helpers';

const PHONE = { width: 390, height: 844 };

/** A company of its own, so empty states and account names don't depend on other specs. */
async function freshCompany(page: Page) {
  const orgId = `org_dev_e2e_nbank_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await devLogin(page, { orgId, orgRole: 'org:admin' });
}

/** Connect the fixture SimpleFIN driver and link its Demo Visa as a credit card, then sync. */
async function linkDemoVisa(page: Page): Promise<BankAccountDto> {
  const cx = await apiPost<BankConnectionDto>(page, '/api/banking/connections', { name: unique('Demo Bank'), setupToken: `demo-e2e-${Date.now()}-nbank`, syncIntervalMinutes: 360 });
  const code = `21${Date.now().toString().slice(-4)}`;
  await apiPost(page, `/api/banking/connections/${cx.id}/link`, {
    version: cx.version,
    links: [{ providerAccountId: 'demo-card', create: { name: 'Demo Visa', kind: 'credit_card', newLedgerAccount: { code, name: 'Demo Visa' } } }],
  });
  await apiPost(page, `/api/banking/connections/${cx.id}/sync`, {});
  const accounts = await apiGet<BankAccountDto[]>(page, '/api/banking/accounts');
  return accounts.find((b) => b.name === 'Demo Visa')!;
}

test.describe('Bank accounts in plain words', () => {
  test.beforeEach(async ({ page }) => {
    await freshCompany(page);
  });

  test('empty page invites one step, explains the bank feed, and a card is added with what is owed', async ({ page }) => {
    await gotoReady(page, '/banking');
    await expect(page.getByRole('heading', { level: 1, name: 'Bank accounts' })).toBeVisible();
    await expect(page.getByText('Add your bank account or card to bring in its transactions.')).toBeVisible();

    // The automatic feed says what SimpleFIN is, what it costs and where to get a token.
    await expect(page.getByRole('heading', { name: 'Automatic bank feed' })).toBeVisible();
    const steps = page.getByTestId('simplefin-steps');
    await expect(steps).toContainText('about $1.50 a month');
    const bridge = steps.getByRole('link', { name: 'SimpleFIN Bridge' });
    await expect(bridge).toHaveAttribute('href', 'https://beta-bridge.simplefin.org/');
    await expect(bridge).toHaveAttribute('target', '_blank');
    await expect(bridge).toHaveAttribute('rel', /noopener/);
    await page.getByRole('button', { name: 'Connect your bank' }).first().click();
    const connect = page.getByRole('dialog', { name: 'Connect your bank' });
    await expect(connect.getByTestId('simplefin-steps')).toBeVisible();
    await connect.getByRole('button', { name: 'Cancel' }).click();

    // Name, type and the statement figure; no ledger codes in sight.
    await page.getByRole('main').getByRole('button', { name: 'Add bank account' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Add bank account' });
    await expect(dialog.getByLabel(/^Account code/)).toBeHidden();
    const name = unique('Amex card');
    await dialog.getByLabel(/^Name/).fill(name);
    await dialog.getByLabel(/^Type/).selectOption('credit_card');
    await dialog.getByLabel(/^Statement date/).fill('2026-09-30');
    await dialog.getByLabel('Amount owed on Sep 30, 2026').fill('250');
    await dialog.getByRole('button', { name: 'Add account' }).click();

    const done = page.getByRole('dialog', { name: `${name} is added` });
    await expect(done.getByTestId('bank-account-added')).toContainText('Starting balance recorded: Owed $250.00 on Sep 30, 2026.');
    await done.getByRole('button', { name: 'Done' }).click();

    const row = page.getByRole('table', { name: 'Bank accounts' }).getByRole('row').filter({ hasText: name });
    await expect(row.getByTestId('balance-evenbooks')).toHaveText('Owed $250.00');
    await expect(row.getByText('Not connected')).toBeVisible();

    // The starting balance landed on the card's own account, dated the statement day.
    const card = (await apiGet<BankAccountDto[]>(page, '/api/banking/accounts')).find((b) => b.name === name)!;
    expect(card.ledgerBalance).toBe('250.00');
  });

  test('a card shows what is owed, the gap is spelled out, and every action fits at 1280px and on a phone', async ({ page }) => {
    const visa = await linkDemoVisa(page);
    expect(visa.lastBalance).toBe('-412.50');

    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoReady(page, '/banking');
    const table = page.getByRole('table', { name: 'Bank accounts' });
    await expect(table.getByRole('columnheader', { name: 'Balance in Evenbooks' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Balance at bank' })).toBeVisible();
    const row = table.getByRole('row').filter({ hasText: 'Demo Visa' });
    await expect(row.getByTestId('balance-bank')).toHaveText('Owed $412.50');
    await expect(row.getByTestId('balance-evenbooks')).toHaveText('Owed $0.00');
    await expect(row.getByTestId('balance-gap')).toHaveText('Evenbooks shows $412.50 less owed than the bank. 3 transactions are still to review, which usually explains it.');

    // Nothing is cut off: Reconcile and the row menu sit inside the viewport.
    const reconcile = row.getByRole('link', { name: 'Reconcile' });
    const box = await reconcile.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    await row.getByRole('button', { name: 'More actions for Demo Visa' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rename…' })).toBeVisible();
    await page.keyboard.press('Escape');

    // Phone: no sideways scroll; Import CSV moves into the row menu.
    await page.setViewportSize(PHONE);
    await gotoReady(page, '/banking');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
    const phoneRow = page.getByRole('table', { name: 'Bank accounts' }).getByRole('row').filter({ hasText: 'Demo Visa' });
    await expect(phoneRow.getByRole('link', { name: 'Reconcile' })).toBeInViewport();
    await expect(phoneRow.getByRole('link', { name: 'Import CSV' })).toBeHidden();
    await phoneRow.getByRole('button', { name: 'More actions for Demo Visa' }).click();
    await expect(page.getByRole('menuitem', { name: 'Import CSV' })).toBeVisible();
  });

  test('card reconciliation prefills what is owed and talks about charges and payments', async ({ page }) => {
    const visa = await linkDemoVisa(page);
    await gotoReady(page, `/banking/reconcile?bankAccountId=${visa.id}`);
    // The provider reports -412.50; on the statement that is $412.50 owed.
    await expect(page.getByLabel(/^Closing balance/)).toHaveValue('412.50');
    await expect(page.getByText(/Prefilled with the amount owed on/)).toBeVisible();

    const rec = await apiPost<ReconciliationDetailDto>(page, '/api/banking/reconciliations', {
      bankAccountId: visa.id,
      statementStartDate: '2026-09-01',
      statementEndDate: '2026-09-30',
      statementOpeningBalance: '0',
      statementClosingBalance: '100',
    });
    await gotoReady(page, `/banking/reconcile/${rec.id}`);
    const totals = page.getByRole('region', { name: 'Reconciliation totals' });
    await expect(totals.getByText('Charges', { exact: true })).toBeVisible();
    await expect(totals.getByText('Payments and credits', { exact: true })).toBeVisible();
    await expect(totals.getByText('Deposits')).toHaveCount(0);
    await expect(page.getByTestId('difference-help')).toContainText('Still to explain: $100.00.');
  });

  test('a bank reconciliation explains the difference in words, and plain buttons tick lines', async ({ page }) => {
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const income = accounts.find((a) => a.code === '4100')!;
    const bank = await apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: 'Checking', kind: 'bank', newLedgerAccount: { code: '1777', name: 'Checking' } });
    await apiPost(page, '/api/journal', {
      date: '2026-09-10',
      memo: 'Deposit',
      cashTreatment: 'include',
      post: true,
      lines: [
        { accountId: bank.ledgerAccountId, debit: '75' },
        { accountId: income.id, credit: '75' },
      ],
    });
    const rec = await apiPost<ReconciliationDetailDto>(page, '/api/banking/reconciliations', {
      bankAccountId: bank.id,
      statementStartDate: '2026-09-01',
      statementEndDate: '2026-09-30',
      statementOpeningBalance: '0',
      statementClosingBalance: '75',
    });
    // The list page explains the idea once, with the accountant's word one tap away.
    await gotoReady(page, '/banking/reconcile');
    await page.getByRole('button', { name: 'Check that Evenbooks agrees with your bank statement' }).click();
    await expect(page.getByRole('dialog', { name: 'Check against your statement' })).toContainText('Accountants call this reconciliation.');
    await page.keyboard.press('Escape');
    await gotoReady(page, `/banking/reconcile/${rec.id}`);
    await expect(page.getByTestId('difference-help')).toHaveText(/Still to explain: \$75\.00\. Look for a line on your statement that isn’t here/);
    await page.getByRole('button', { name: 'Mark all as on statement' }).click();
    await expect(page.getByTestId('stat-difference')).toHaveText('$0.00');
    await expect(page.getByTestId('difference-help')).toContainText('Everything on the statement is accounted for.');
    await page.getByRole('button', { name: 'Unmark all' }).click();
    await expect(page.getByTestId('cleared-count')).toHaveText('0 of 1 on statement');
  });

  test('an expense recorded from a bank line takes a receipt afterwards', async ({ page }) => {
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const bank = await apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: 'Checking', kind: 'bank', ledgerAccountId: accounts.find((a) => a.code === '1000')!.id });
    const line = await apiPost<BankTransactionDto>(page, '/api/banking/transactions', { bankAccountId: bank.id, date: '2026-09-02', amount: '-40', description: 'PRINTER INK' });
    await apiPost(page, `/api/banking/transactions/${line.id}/categorize`, { version: line.version, lines: [{ accountId: accounts.find((a) => a.code === '5140')!.id, amount: '40', description: '' }] });
    const purchase = (await apiGet<{ items: PurchaseDto[] }>(page, '/api/purchases?limit=10')).items.find((p) => p.bankTransactionId === line.id)!;

    await gotoReady(page, `/purchases/${purchase.id}`);
    await expect(page.getByRole('main').getByRole('link', { name: 'Expenses' })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Expense lines' }).getByRole('columnheader', { name: 'Category' })).toBeVisible();
    await expect(page.getByText('No receipts attached')).toBeVisible();
    await page.getByTestId('attach-receipt-input').setInputFiles({ name: 'ink-receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await expect(page.getByText('Receipt attached')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Attachments' }).getByText('ink-receipt.pdf')).toBeVisible();

    // The file is linked to the expense on the server, not just shown.
    const files = await apiGet<{ fileName: string; entityType: string }[]>(page, `/api/attachments?entityType=purchase&entityId=${purchase.id}`);
    expect(files.map((f) => f.fileName)).toEqual(['ink-receipt.pdf']);

    // The list says Expenses, and a normal row carries no "Posted" badge.
    await gotoReady(page, '/purchases');
    await expect(page.getByRole('heading', { level: 1, name: 'Expenses' })).toBeVisible();
    const row = page.getByRole('table', { name: 'Expenses' }).getByRole('row').filter({ hasText: 'PRINTER INK' });
    await expect(row.getByText(/Posted/)).toHaveCount(0);
  });

  test('uploading onto a record that is not in this company is refused', async ({ page }) => {
    const res = await page.request.post('/api/attachments', {
      headers: { 'x-company-id': (await apiGet<{ company: { id: string } }>(page, '/api/session')).company.id },
      multipart: {
        file: { name: 'r.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
        kind: 'receipt',
        entityType: 'purchase',
        entityId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(res.status()).toBe(404);
  });

  test('the CSV import speaks plainly and hints at card signs', async ({ page }) => {
    const card = await apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: 'Card', kind: 'credit_card', newLedgerAccount: { code: '2777', name: 'Card' } });
    await gotoReady(page, `/banking/import?bankAccountId=${card.id}`);
    await expect(page.getByText('Lines you already imported are skipped.', { exact: false })).toBeVisible();
    const csv = ['Date,Description,Amount', '09/05/2026,Coffee,4.50', 'nope,Broken,1.00'].join('\n');
    await page.getByLabel(/^CSV file/).setInputFiles({ name: 'card.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByTestId('invert-card-hint')).toContainText('For a card statement, charges should come out as money out');
    const rows = page.getByRole('table', { name: 'Preview rows' });
    await expect(rows.getByText('Ready', { exact: true })).toBeVisible();
    await expect(rows.getByText('Problem', { exact: true })).toBeVisible();
    await expect(rows.getByText(/^ok$|^error$/)).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Recent imports' }).getByText('Not imported yet')).toBeVisible();
  });
});
