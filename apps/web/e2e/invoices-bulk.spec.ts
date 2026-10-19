import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { AccountDto, ContactDto, EmailMessageDto, InvoiceDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, unique } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

async function incomeAccount(page: Page): Promise<AccountDto> {
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const income = accounts.find((a) => a.type === 'income' && a.isActive);
  expect(income).toBeTruthy();
  return income!;
}

async function draftInvoice(page: Page, contactId: string, accountId: string, memo: string, price: string): Promise<InvoiceDto> {
  return apiPost<InvoiceDto>(page, '/api/invoices', {
    contactId,
    issueDate: today(),
    termsDays: 14,
    memo,
    lines: [{ description: 'Bulk work', quantity: '1', unitPrice: price, incomeAccountId: accountId, taxRateIds: [] }],
  });
}

async function issuedInvoice(page: Page, contactId: string, accountId: string, memo: string, price: string): Promise<InvoiceDto> {
  const d = await draftInvoice(page, contactId, accountId, memo, price);
  return apiPost<InvoiceDto>(page, `/api/invoices/${d.id}/issue`, { version: d.version, idempotencyKey: `e2e-bulk-issue-${d.id}` });
}

test.describe('Invoice and contact lists: sorting and bulk actions', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
  });

  test('invoices: sort by total, count in the pager, export, issue and send the selection', async ({ page }) => {
    test.setTimeout(120_000);
    const tag = unique('BulkInv');
    const income = await incomeAccount(page);
    const withEmail = await apiPost<ContactDto>(page, '/api/contacts', { name: `${tag} Mailable`, isCustomer: true, email: 'bulk@example.com' });
    const noEmail = await apiPost<ContactDto>(page, '/api/contacts', { name: `${tag} Silent`, isCustomer: true });
    await draftInvoice(page, withEmail.id, income.id, `${tag} d1`, '100');
    await draftInvoice(page, noEmail.id, income.id, `${tag} d2`, '250');
    const sentOne = await issuedInvoice(page, withEmail.id, income.id, `${tag} i1`, '40');
    await issuedInvoice(page, noEmail.id, income.id, `${tag} i2`, '60');

    await gotoReady(page, `/invoices?q=${encodeURIComponent(tag)}`);
    const table = page.getByRole('table', { name: 'Invoices' });
    await expect(table.getByRole('row')).toHaveCount(5);
    await expect(page.getByText(/^4 invoices/)).toBeVisible();

    // Sorting: Total starts largest first, a second click flips it.
    await table.getByRole('button', { name: 'Total' }).click();
    await expect(page).toHaveURL(/sort=total&dir=desc/);
    await expect(table.getByRole('columnheader', { name: 'Total' })).toHaveAttribute('aria-sort', 'descending');
    await expect(table.getByRole('row').nth(1)).toContainText('$250.00');
    await table.getByRole('button', { name: 'Total' }).click();
    await expect(page).toHaveURL(/dir=asc/);
    await expect(table.getByRole('row').nth(1)).toContainText('$40.00');

    // Select the whole page: two drafts to issue, two issued to send.
    await table.getByRole('checkbox', { name: 'Select all on this page' }).check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await expect(bar).toContainText('4 selected');
    await expect(bar.getByRole('button', { name: 'Send 2' })).toBeEnabled();

    // Export selected: a CSV of exactly the selected rows.
    const downloadPromise = page.waitForEvent('download');
    await bar.getByRole('button', { name: 'Export selected' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('invoices-selected.csv');
    const csv = await readFile((await download.path())!, 'utf8');
    const lines = csv.trim().split(/\r\n/);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('Number,Customer');

    // Issue the drafts (after a confirmation); they leave the selection once issued.
    await bar.getByRole('button', { name: 'Issue 2 drafts' }).click();
    await page.getByRole('dialog', { name: 'Issue 2 drafts?' }).getByRole('button', { name: 'Issue 2' }).click();
    await expect(page.getByText('Issued 2 invoices')).toBeVisible();
    await expect(table.getByRole('link', { name: 'Draft' })).toHaveCount(0);
    await expect(bar).toContainText('2 selected');

    // Send: one customer has an email, the other is skipped and reported.
    await bar.getByRole('button', { name: 'Send 2' }).click();
    await page.getByRole('dialog', { name: 'Email 2 invoices?' }).getByRole('button', { name: 'Send 2' }).click();
    const results = page.getByRole('dialog', { name: 'Send results' });
    await expect(results).toBeVisible();
    await expect(results.getByTestId('bulk-result-row')).toHaveCount(2);
    await expect(results.getByTestId('bulk-result-row').filter({ hasText: 'Mailable' })).toContainText('Queued');
    await expect(results.getByTestId('bulk-result-row').filter({ hasText: 'Silent' })).toContainText('The customer has no email address');
    await results.getByRole('button', { name: 'Close' }).first().click();
    await expect(results).toBeHidden();

    const emails = await apiGet<EmailMessageDto[]>(page, `/api/invoices/${sentOne.id}/emails`);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.toEmail).toBe('bulk@example.com');
  });

  test('contacts: sort by name, archive a selection and undo it', async ({ page }) => {
    const tag = unique('BulkCon');
    await apiPost<ContactDto>(page, '/api/contacts', { name: `${tag} Alder`, isCustomer: true });
    await apiPost<ContactDto>(page, '/api/contacts', { name: `${tag} birch`, isCustomer: true });

    await gotoReady(page, `/contacts?q=${encodeURIComponent(tag)}`);
    const table = page.getByRole('table', { name: 'Contacts' });
    await expect(table.getByRole('row')).toHaveCount(3);
    await expect(page.getByText(/^2 contacts/)).toBeVisible();
    await expect(table.getByRole('row').nth(1)).toContainText('Alder');
    // Name is the default (A–Z); its first click flips to Z–A.
    await table.getByRole('button', { name: 'Name' }).click();
    await expect(page).toHaveURL(/sort=name&dir=desc/);
    await expect(table.getByRole('row').nth(1)).toContainText('birch');

    await table.getByRole('checkbox', { name: 'Select all on this page' }).check();
    const bar = page.getByRole('region', { name: 'Bulk actions' });
    await bar.getByRole('button', { name: 'Archive 2' }).click();
    const toast = page.getByRole('status').filter({ hasText: 'Archived 2 contacts' });
    await expect(toast).toBeVisible();
    await expect(page.getByText('No contacts match')).toBeVisible();

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Restored 2 contacts')).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(3);
  });
});
