import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, BankAccountDto, BankTransactionDto, CompanyDto, ContactDto, InvoiceDto, PaymentDto, ReconciliationDetailDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, menuItem } from './helpers';

/** A fresh company per test so deletes never collide with other specs. */
async function freshCompany(page: Page, role: 'org:admin' | 'org:member' = 'org:admin') {
  const orgId = `org_dev_e2e_delete_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await devLogin(page, { orgId, orgRole: role });
  return orgId;
}

async function issuedInvoice(page: Page, amount = '250') {
  const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: 'Delete Test Customer', isCustomer: true });
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const income = accounts.find((a) => a.code === '4100')!;
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', { contactId: customer.id, issueDate: '2026-06-01', lines: [{ description: 'Work', quantity: '1', unitPrice: amount, incomeAccountId: income.id, taxRateIds: [] }] });
  return apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
}

test.describe('Permanent deletion', () => {
  test('an admin deletes an issued invoice; it disappears with its entry', async ({ page }) => {
    await freshCompany(page);
    const inv = await issuedInvoice(page);
    await gotoReady(page, `/invoices/${inv.id}`);
    await (await menuItem(page, 'Delete…')).click();
    const dialog = page.getByRole('dialog', { name: 'Delete invoice permanently' });
    await expect(dialog.getByTestId('delete-entries')).toContainText('#1');
    await dialog.getByLabel(/^Reason/).fill('Created by mistake');
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page).toHaveURL(/\/invoices$/);
    const res = await page.request.get(`/api/invoices/${inv.id}`);
    expect(res.status()).toBe(404);
    const journal = await apiGet<{ items: unknown[] }>(page, '/api/journal?limit=10');
    expect(journal.items).toHaveLength(0);
  });

  test('a payment applied to the invoice blocks the delete and is linked', async ({ page }) => {
    await freshCompany(page);
    const inv = await issuedInvoice(page);
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const payment = await apiPost<PaymentDto>(page, '/api/payments', { contactId: inv.contactId, date: '2026-06-05', amount: '100', method: 'check', depositAccountId: accounts.find((a) => a.code === '1000')!.id, allocations: [{ invoiceId: inv.id, amount: '100' }] });
    await gotoReady(page, `/invoices/${inv.id}`);
    await (await menuItem(page, 'Delete…')).click();
    const dialog = page.getByRole('dialog', { name: 'Delete invoice permanently' });
    await expect(dialog.getByTestId('delete-blockers')).toContainText('Delete the payment first');
    await expect(dialog.getByRole('button', { name: 'Delete permanently' })).toBeDisabled();
    await dialog.getByRole('link', { name: /Open Payment of 100\.00/ }).click();
    await expect(page).toHaveURL(new RegExp(`/payments/${payment.id}$`));

    // deleting the payment reopens the invoice
    await (await menuItem(page, 'Delete…')).click();
    const pd = page.getByRole('dialog', { name: 'Delete payment permanently' });
    await expect(pd).toContainText('Balances are recalculated on Invoice');
    await pd.getByLabel(/^Reason/).fill('Recorded twice');
    await pd.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page).toHaveURL(/\/payments$/);
    const after = await apiGet<InvoiceDto>(page, `/api/invoices/${inv.id}`);
    expect(after.balanceDue).toBe('250.00');
  });

  test('deleting a reconciled bank purchase warns, then reopens the reconciliation', async ({ page }) => {
    await freshCompany(page);
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const bank = await apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: 'Checking', kind: 'bank', ledgerAccountId: accounts.find((a) => a.code === '1000')!.id });
    const line = await apiPost<BankTransactionDto>(page, '/api/banking/transactions', { bankAccountId: bank.id, date: '2026-07-02', amount: '-40', description: 'PRINTER INK' });
    await apiPost(page, `/api/banking/transactions/${line.id}/categorize`, { version: line.version, lines: [{ accountId: accounts.find((a) => a.code === '5140')!.id, amount: '40', description: '' }] });
    const rec = await apiPost<ReconciliationDetailDto>(page, '/api/banking/reconciliations', { bankAccountId: bank.id, statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', statementOpeningBalance: '0', statementClosingBalance: '-40.00' });
    const toggled = await apiPost<ReconciliationDetailDto>(page, `/api/banking/reconciliations/${rec.id}/items`, { version: rec.version, clear: rec.lines.map((l) => l.journalLineId), unclear: [] });
    await apiPost(page, `/api/banking/reconciliations/${rec.id}/complete`, { version: toggled.version });
    const purchases = await apiGet<{ items: { id: string }[] }>(page, '/api/purchases?limit=10');

    await gotoReady(page, `/purchases/${purchases.items[0]!.id}`);
    await (await menuItem(page, 'Delete…')).click();
    const dialog = page.getByRole('dialog', { name: 'Delete purchase permanently' });
    await expect(dialog.getByTestId('delete-reconciliations')).toContainText('Checking, statement ending');
    await expect(dialog).toContainText('PRINTER INK');
    await dialog.getByLabel(/^Reason/).fill('Personal purchase');
    await dialog.getByRole('button', { name: 'Delete permanently' }).click();
    await expect(page).toHaveURL(/\/purchases$/);
    const after = await apiGet<ReconciliationDetailDto>(page, `/api/banking/reconciliations/${rec.id}`);
    expect(after.status).toBe('in_progress');
    const txn = await apiGet<BankTransactionDto>(page, `/api/banking/transactions/${line.id}`);
    expect(txn.status).toBe('unreviewed');
  });

  test('turning the setting off hides Delete; members never see it', async ({ page }) => {
    const orgId = await freshCompany(page);
    const inv = await issuedInvoice(page);
    await gotoReady(page, '/settings/company');
    const toggle = page.getByLabel('Allow administrators to delete transactions permanently');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    const company = await apiGet<CompanyDto>(page, '/api/company');
    expect(company.transactionDeletionEnabled).toBe(false);
    await gotoReady(page, `/invoices/${inv.id}`);
    await expect(await menuItem(page, 'Void…')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete…' })).toHaveCount(0);
    const refused = await page.request.post('/api/deletions', { data: { type: 'invoice', id: inv.id, version: inv.version, reason: 'x' }, headers: { 'x-company-id': company.id } });
    expect(refused.status()).toBe(403);

    // back on, but as a member
    await apiPost(page, '/api/company', { version: company.version, transactionDeletionEnabled: true }, 'PATCH');
    await devLogin(page, { orgId, orgRole: 'org:member', userId: 'user_dev_bookkeeper' });
    await gotoReady(page, `/invoices/${inv.id}`);
    await expect(await menuItem(page, 'Void…')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete…' })).toHaveCount(0);
    const forbidden = await page.request.get(`/api/deletions/preview?type=invoice&id=${inv.id}`, { headers: { 'x-company-id': company.id } });
    expect(forbidden.status()).toBe(403);
  });
});
