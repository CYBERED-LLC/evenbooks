import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady } from './helpers';

const isoDaysFromNow = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function issue(page: Page, contactId: string, issueDate: string, termsDays: number) {
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const income = accounts.find((a) => a.code === '4100')!;
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', { contactId, issueDate, termsDays, lines: [{ description: 'Work', quantity: '1', unitPrice: '300', incomeAccountId: income.id, taxRateIds: [] }] });
  const inv = await apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
  return { inv, accounts };
}

test.describe('Invoice status and balance', () => {
  test.beforeEach(async ({ page }) => {
    const orgId = `org_dev_e2e_status_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await devLogin(page, { orgId, orgRole: 'org:admin' });
  });

  test('says unpaid, partially paid or paid, with the balance in the header', async ({ page }) => {
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: 'Status Customer', isCustomer: true });
    const { inv, accounts } = await issue(page, customer.id, isoDaysFromNow(0), 10);
    await gotoReady(page, `/invoices/${inv.id}`);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading.getByText('Unpaid', { exact: true })).toBeVisible();
    await expect(page.getByTestId('balance-summary')).toHaveText('$300.00 due');
    await expect(page.getByRole('main')).toContainText('(in 10 days)');
    // The customer name in the header opens the contact.
    await page.getByRole('main').getByRole('link', { name: 'Status Customer' }).first().click();
    await expect(page).toHaveURL(new RegExp(`/contacts/${customer.id}$`));

    // A part payment: "Partially paid", and the header shows what is left of the total.
    const checking = accounts.find((a) => a.code === '1000')!;
    await apiPost(page, '/api/payments', { contactId: customer.id, date: isoDaysFromNow(0), amount: '100', method: 'check', depositAccountId: checking.id, allocations: [{ invoiceId: inv.id, amount: '100' }] });
    await gotoReady(page, `/invoices/${inv.id}`);
    await expect(heading.getByText('Partially paid', { exact: true })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('$200.00 due of $300.00');
    await expect(page.getByRole('table', { name: 'Payments and credits' })).toBeVisible();

    // The list uses the same words; the "Unpaid" tab matches the badge.
    await gotoReady(page, `/invoices?contactId=${customer.id}`);
    await expect(page.getByRole('table', { name: 'Invoices' }).getByText('Partially paid', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Unpaid', exact: true }).click();
    await expect(page).toHaveURL(/tab=issued/);
    await expect(page.getByRole('table', { name: 'Invoices' }).getByText('Partially paid', { exact: true })).toBeVisible();

    // Paid in full.
    await apiPost(page, '/api/payments', { contactId: customer.id, date: isoDaysFromNow(0), amount: '200', method: 'check', depositAccountId: checking.id, allocations: [{ invoiceId: inv.id, amount: '200' }] });
    await gotoReady(page, `/invoices/${inv.id}`);
    await expect(heading.getByText('Paid', { exact: true })).toBeVisible();
    await expect(page.getByRole('main')).toContainText('$300.00 paid in full');
  });

  test('overdue is said once in the header, not in a banner too', async ({ page }) => {
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: 'Late Customer', isCustomer: true });
    const { inv } = await issue(page, customer.id, isoDaysFromNow(-40), 30);
    await gotoReady(page, `/invoices/${inv.id}`);
    await expect(page.getByRole('heading', { level: 1 }).getByText('Overdue', { exact: true })).toBeVisible();
    await expect(page.getByTestId('balance-summary')).toHaveText('$300.00 overdue');
    await expect(page.getByRole('main')).toContainText('(10 days ago)');
    await expect(page.getByRole('main').getByRole('status').filter({ hasText: 'Overdue' })).toHaveCount(0);
  });

  test('activity: one timeline instead of empty email and PDF cards', async ({ page }) => {
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: 'Activity Customer', email: 'activity@example.com', isCustomer: true });
    const { inv } = await issue(page, customer.id, isoDaysFromNow(0), 30);
    await gotoReady(page, `/invoices/${inv.id}`);
    const activity = page.getByRole('list', { name: 'Activity' });
    await expect(activity.getByRole('listitem')).toHaveCount(1);
    await expect(activity).toContainText(`Issued ${inv.number}`);
    await expect(page.getByText('Not emailed to the customer yet.')).toBeVisible();
    // Nothing applied yet, so there is no allocations card either.
    await expect(page.getByRole('heading', { name: 'Payments and credits' })).toHaveCount(0);
    await expect(page.getByText('Not sent yet')).toHaveCount(0);
    await expect(page.getByText('No PDF generated yet')).toHaveCount(0);

    await page.getByRole('button', { name: 'Send…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Email queued')).toBeVisible();
    await expect(activity.getByRole('listitem').filter({ hasText: 'Emailed to activity@example.com' })).toBeVisible();
    await expect(page.getByText('Not emailed to the customer yet.')).toHaveCount(0);
    await expect(activity.getByRole('button', { name: 'Resend to activity@example.com' })).toBeVisible();
  });

  test('creating a customer by typing an email address fills in the email', async ({ page }) => {
    const email = `typed-${Date.now().toString(36)}@example.com`;
    await gotoReady(page, '/invoices/new');
    const field = page.getByRole('combobox', { name: 'Customer' });
    await field.click();
    await field.fill(email);
    await page.getByRole('option', { name: `New contact “${email}”` }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/^Name/)).toHaveValue(email);
    await expect(dialog.getByLabel('Email')).toHaveValue(email);
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(field).toHaveValue(email);

    // Plain text is still just a name.
    await field.fill('Plain Name Co');
    await page.getByRole('option', { name: 'New contact “Plain Name Co”' }).click();
    await expect(dialog.getByLabel(/^Name/)).toHaveValue('Plain Name Co');
    await expect(dialog.getByLabel('Email')).toHaveValue('');
  });

  test('send fills in the contact’s current email when the invoice was issued without one', async ({ page }) => {
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: 'No Email Yet', isCustomer: true });
    const { inv } = await issue(page, customer.id, isoDaysFromNow(0), 30);
    await gotoReady(page, `/invoices/${inv.id}`);
    await page.getByRole('button', { name: 'Send…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(/^To/)).toHaveValue('');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    // The email is added to the contact after the invoice was issued.
    await apiPost(page, `/api/contacts/${customer.id}`, { version: customer.version, email: 'later@example.com' }, 'PATCH');
    await gotoReady(page, `/invoices/${inv.id}`);
    await page.getByRole('button', { name: 'Send…' }).click();
    await expect(dialog.getByLabel(/^To/)).toHaveValue('later@example.com');
    await expect(dialog).toContainText('From the contact’s current details.');
    await dialog.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Email queued')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Activity' }).getByRole('listitem').filter({ hasText: 'Emailed to later@example.com' })).toBeVisible();
  });
});
