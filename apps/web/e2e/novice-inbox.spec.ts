import { test, expect, type Locator, type Page } from '@playwright/test';
import type { AccountDto, BankAccountDto, BankTransactionDto, InvoiceDto, PaymentDto, PurchaseDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, pickOption } from './helpers';

/**
 * Plain-language bank inbox (docs/novice-ux-plan.md 0.1–0.3, 0.11, 0.12, 1.4).
 * Every test runs in its own fresh company, so amounts never collide with
 * invoices or payments that other specs leave behind.
 */

async function freshCompany(page: Page) {
  const orgId = `org_dev_e2e_novinbox_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await devLogin(page, { orgId, orgRole: 'org:admin' });
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const code = (c: string) => accounts.find((a) => a.code === c)!;
  return { accounts, code };
}

async function checking(page: Page, ledgerAccountId: string) {
  return apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: 'Checking', kind: 'bank', ledgerAccountId });
}

const line = (page: Page, bankAccountId: string, date: string, amount: string, description: string) =>
  apiPost<BankTransactionDto>(page, '/api/banking/transactions', { bankAccountId, date, amount, description });

async function issuedInvoice(page: Page, contactId: string, amount: string, incomeAccountId: string, issueDate = '2026-09-01') {
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', { contactId, issueDate, lines: [{ description: 'Design work', quantity: '1', unitPrice: amount, incomeAccountId }] });
  return apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
}

async function customer(page: Page, name: string) {
  return apiPost<{ id: string; name: string }>(page, '/api/contacts', { name, isCustomer: true, isVendor: false });
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

test.describe('Plain-language bank inbox', () => {
  test('empty states say how to bring transactions in, then that everything is reviewed', async ({ page }) => {
    const { code } = await freshCompany(page);
    await gotoReady(page, '/banking/inbox');
    await expect(page.getByRole('heading', { level: 1, name: 'Bank transactions' })).toBeVisible();
    await expect(page.getByText('No bank transactions yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect your bank' })).toHaveAttribute('href', '/banking');
    await expect(page.getByRole('link', { name: 'Upload a statement' })).toHaveAttribute('href', '/banking/import');

    const bank = await checking(page, code('1000').id);
    const t = await line(page, bank.id, '2026-09-10', '-8.00', 'PARKING');
    await apiPost(page, `/api/banking/transactions/${t.id}/categorize`, { version: t.version, lines: [{ accountId: code('5140').id, amount: '8.00', description: '' }] });
    await gotoReady(page, '/banking/inbox');
    await expect(page.getByText('All caught up')).toBeVisible();
    await expect(page.getByText('New bank transactions will show up here to review.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Connect your bank' })).toHaveCount(0);
    await page.getByRole('button', { name: 'See categorized transactions' }).click();
    await expect(tab(page, 'Categorized')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('txn-row').filter({ hasText: 'PARKING' })).toBeVisible();
  });

  test('a customer deposit pays the invoice in one step; Accept never adds it as income', async ({ page }) => {
    const { code } = await freshCompany(page);
    const bank = await checking(page, code('1000').id);
    const acme = await customer(page, 'Acme Studio');
    const inv = await issuedInvoice(page, acme.id, '500', code('4100').id);
    // A rule would happily call every deposit Sales; the invoice match must win.
    await apiPost(page, '/api/banking/rules', { name: 'Deposits', pattern: 'DEPOSIT', matchType: 'contains', direction: 'in', accountId: code('4100').id });
    await line(page, bank.id, '2026-09-12', '500', 'MOBILE DEPOSIT');

    await gotoReady(page, '/banking/inbox');
    const row = page.getByTestId('txn-row').filter({ hasText: 'MOBILE DEPOSIT' });
    await expect(row.getByRole('button', { name: 'Unpaid invoice found' })).toBeVisible();
    await expect(row.getByRole('button', { name: /^Accept suggestion/ })).toHaveCount(0);
    // Enter on the row opens the review on Match instead of accepting
    await row.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: /^Match/ })).toHaveAttribute('aria-selected', 'true');
    const choice = dialog.getByRole('checkbox', { name: new RegExp(`^Unpaid invoice ${inv.number} · Acme Studio · \\$500\\.00 · due`) });
    await expect(choice).toBeChecked();
    await expect(dialog.getByText(`pays ${inv.number} in full`)).toBeVisible();
    await expectPost(page, '/pay-invoice', () => dialog.getByRole('button', { name: 'Record payment', exact: true }).click());
    await expect(toast(page, `Payment recorded for ${inv.number}`)).toBeVisible();
    await expect(tab(page, 'Matched')).toContainText('1');
    expect((await apiGet<InvoiceDto>(page, `/api/invoices/${inv.id}`)).status).toBe('paid');
  });

  test('categorizing a deposit as income warns about the unpaid invoice and switches to it', async ({ page }) => {
    const { code } = await freshCompany(page);
    const bank = await checking(page, code('1000').id);
    const acme = await customer(page, 'Bright Bakery');
    const inv = await issuedInvoice(page, acme.id, '250', code('4100').id);
    const other = await issuedInvoice(page, acme.id, '100', code('4100').id, '2026-09-02');
    await line(page, bank.id, '2026-09-15', '375', 'BRIGHT BAKERY ACH');

    await gotoReady(page, '/banking/inbox');
    await page.getByRole('button', { name: 'Review BRIGHT BAKERY ACH' }).click();
    const dialog = page.getByRole('dialog');
    // No invoice for exactly $375: Categorize first, with the plain choices on top
    await expect(dialog.getByRole('tab', { name: /^Categorize/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('button', { name: 'Customer paid an invoice' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Money I put in (owner contribution)' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Customer paid an invoice' }).click();
    await expect(dialog.getByRole('tab', { name: /^Match/ })).toHaveAttribute('aria-selected', 'true');
    // The bank description names the customer, so both of their invoices are offered
    await dialog.getByRole('checkbox', { name: new RegExp(`^Unpaid invoice ${inv.number}`) }).check();
    await dialog.getByRole('checkbox', { name: new RegExp(`^Unpaid invoice ${other.number}`) }).check();
    await expect(dialog.getByText(/\$25\.00 extra is kept as credit for Bright Bakery/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Record payment', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // A deposit for exactly one invoice, typed as income, gets the warning and the one-click switch
    await line(page, bank.id, '2026-09-16', '250', 'COUNTER DEPOSIT');
    await gotoReady(page, '/banking/inbox');
    await page.getByRole('button', { name: 'Review COUNTER DEPOSIT' }).click();
    await dialog.getByRole('tab', { name: /^Categorize/ }).click();
    await pickOption(dialog.getByLabel(/^Category/), '4100', /^4100/);
    await expect(dialog.getByText(`This looks like payment for ${inv.number} from Bright Bakery. Record it as an invoice payment instead?`)).toBeVisible();
    await dialog.getByRole('button', { name: 'Record invoice payment' }).click();
    await expect(dialog.getByRole('tab', { name: /^Match/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('checkbox', { name: new RegExp(`^Unpaid invoice ${inv.number}`) })).toBeChecked();
    await expectPost(page, '/pay-invoice', () => dialog.getByRole('button', { name: 'Record payment', exact: true }).click());
    expect((await apiGet<InvoiceDto>(page, `/api/invoices/${inv.id}`)).status).toBe('paid');
  });

  test('payments waiting to be deposited add up to one deposit, with readable labels', async ({ page }) => {
    const { code } = await freshCompany(page);
    const bank = await checking(page, code('1000').id);
    const acme = await customer(page, 'Cobalt Cafe');
    const inv = await issuedInvoice(page, acme.id, '80', code('4100').id);
    await apiPost<PaymentDto>(page, '/api/payments', { contactId: acme.id, date: '2026-09-18', amount: '80', method: 'check', depositAccountId: code('1050').id, allocations: [{ invoiceId: inv.id, amount: '80' }] });
    await apiPost<PaymentDto>(page, '/api/payments', { contactId: acme.id, date: '2026-09-19', amount: '45.50', method: 'cash', depositAccountId: code('1050').id, allocations: [] });
    await line(page, bank.id, '2026-09-20', '125.50', 'BRANCH DEPOSIT');

    await gotoReady(page, '/banking/inbox');
    await page.getByRole('button', { name: 'Review BRANCH DEPOSIT' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: /^Match/ }).click();
    const first = dialog.getByRole('checkbox', { name: new RegExp(`^Payment from Cobalt Cafe · ${inv.number}`) });
    const second = dialog.getByRole('checkbox', { name: /^Payment from Cobalt Cafe\s*Sep 19/ });
    await expect(first).toBeChecked();
    await expect(second).toBeChecked();
    await expect(dialog.getByText('Waiting to be deposited').first()).toBeVisible();
    await expect(dialog).not.toContainText('entry #');
    await expectPost(page, '/match', () => dialog.getByRole('button', { name: 'Match', exact: true }).click());
    await expect(toast(page, 'Transaction matched')).toBeVisible();
    await expect(tab(page, 'Matched')).toContainText('1');
  });

  test('personal spending records an owner draw with its receipt; Exclude is only for lines that aren’t real', async ({ page }) => {
    const { code } = await freshCompany(page);
    const bank = await checking(page, code('1000').id);
    const t = await line(page, bank.id, '2026-09-21', '-64.10', 'GROCERY MART');
    await line(page, bank.id, '2026-09-22', '-19.99', 'OFFICE DEPOT');

    await gotoReady(page, '/banking/inbox');
    await page.getByRole('button', { name: 'Review GROCERY MART' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Exclude' }).click();
    await expect(dialog.getByText(/Only for lines that aren’t real: duplicates, or a charge the bank reversed\. Personal spending still left your account/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Personal', exact: true })).toHaveCount(0);

    await dialog.getByRole('tab', { name: /^Categorize/ }).click();
    await dialog.getByRole('button', { name: 'Personal spending (owner draw)', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Personal spending (owner draw)', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByLabel(/^Category/)).toHaveValue(/Owner's Draws/);
    await dialog.getByLabel('Receipt', { exact: true }).setInputFiles({ name: 'groceries.png', mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
    await expect(dialog.getByLabel('Receipt uploads')).toContainText('Uploaded');
    await expectPost(page, '/categorize', () => dialog.getByRole('button', { name: 'Categorize', exact: true }).click());
    await expect(toast(page, 'Transaction categorized')).toBeVisible();

    const done = await apiGet<BankTransactionDto>(page, `/api/banking/transactions/${t.id}`);
    expect(done.status).toBe('categorized');
    const purchases = await apiGet<{ items: PurchaseDto[] }>(page, '/api/purchases');
    expect(purchases.items.some((p) => p.bankTransactionId === t.id)).toBe(false);
    const files = await apiGet<{ fileName: string }[]>(page, `/api/attachments?entityType=journal_entry&entityId=${done.journalEntryId}`);
    expect(files.map((f) => f.fileName)).toEqual(['groceries.png']);

    // A real expense keeps its receipt on the expense
    await page.getByRole('button', { name: 'Review OFFICE DEPOT' }).click();
    await pickOption(dialog.getByLabel(/^Category/), '5110', /^5110/);
    await dialog.getByLabel('Receipt', { exact: true }).setInputFiles({ name: 'depot.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') });
    await expect(dialog.getByLabel('Receipt uploads')).toContainText('Uploaded');
    await expectPost(page, '/categorize', () => dialog.getByRole('button', { name: 'Categorize', exact: true }).click());
    const expense = (await apiGet<{ items: PurchaseDto[] }>(page, '/api/purchases')).items.find((p) => p.memo === 'OFFICE DEPOT' || p.bankTransactionId)!;
    const receipts = await apiGet<{ fileName: string }[]>(page, `/api/attachments?entityType=purchase&entityId=${expense.id}`);
    expect(receipts.map((f) => f.fileName)).toEqual(['depot.pdf']);
  });

  test('bulk accept skips lines that are already recorded and says so', async ({ page }) => {
    const { code } = await freshCompany(page);
    const bank = await checking(page, code('1000').id);
    const vendor = await apiPost<{ id: string }>(page, '/api/contacts', { name: 'Paper Co', isCustomer: false, isVendor: true });
    await apiPost(page, '/api/banking/rules', { name: 'Paper', pattern: 'PAPER', matchType: 'contains', direction: 'out', accountId: code('5110').id });
    // Recorded by hand last week; the bank line for it arrives now
    await apiPost(page, '/api/purchases', { date: '2026-09-23', contactId: vendor.id, paidFromAccountId: code('1000').id, direction: 'outflow', lines: [{ accountId: code('5110').id, description: 'Paper', amount: '30.00' }], attachmentIds: [] });
    await line(page, bank.id, '2026-09-24', '-30.00', 'PAPER CO 1');
    await line(page, bank.id, '2026-09-24', '-12.00', 'PAPER CO 2');

    await gotoReady(page, '/banking/inbox');
    const recorded = page.getByTestId('txn-row').filter({ hasText: 'PAPER CO 1' });
    await expect(recorded.getByRole('button', { name: 'Match found' })).toBeVisible();
    await expect(recorded.getByRole('button', { name: 'Match PAPER CO 1' })).toBeVisible();
    await expect(recorded.getByRole('button', { name: /^Accept suggestion/ })).toHaveCount(0);

    await page.getByLabel('Select all on this page').check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar).toContainText('1 skipped: already recorded');
    await expectPost(page, '/api/banking/transactions/bulk', () => bar.getByRole('button', { name: 'Accept 1 suggestion' }).click());
    await expect(toast(page, 'Categorized 1 transaction')).toContainText('1 skipped: already recorded');
    await expect(page.getByTestId('txn-row')).toHaveCount(1);

    // The skipped line opens on Match with the expense it duplicates
    await recorded.getByRole('button', { name: 'Match PAPER CO 1' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: /^Match/ })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('checkbox', { name: /^Expense · Paper Co/ })).toBeChecked();
  });

  test('a link with transactionId opens that line, on the tab that lists it', async ({ page }) => {
    const { code } = await freshCompany(page);
    const bank = await checking(page, code('1000').id);
    const open = await line(page, bank.id, '2026-09-25', '-15.00', 'TAXI RIDE');
    const done = await line(page, bank.id, '2026-09-26', '-9.00', 'SANDWICH');
    await apiPost(page, `/api/banking/transactions/${done.id}/categorize`, { version: done.version, lines: [{ accountId: code('5140').id, amount: '9.00', description: '' }] });

    await gotoReady(page, `/banking/inbox?transactionId=${open.id}`);
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Review: TAXI RIDE' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page).not.toHaveURL(/transactionId=/);

    await gotoReady(page, `/banking/inbox?transactionId=${done.id}`);
    const dialog = page.getByRole('dialog', { name: 'SANDWICH' });
    await expect(dialog).toContainText('Categorized and recorded in your books');
    await expect(dialog).toContainText('Undo review takes this out of your books');
    await expect(tab(page, 'Categorized')).toHaveAttribute('aria-selected', 'true');
  });
});
