import { test, expect } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto, InvoicePresentationDto, EmailMessageDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin } from './helpers';

test.use({ actionTimeout: 15_000 });

test('company invoice templates, previews, sender setup and individual overrides', async ({ page }) => {
  test.setTimeout(180_000);
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  await devLogin(page, { orgId: `org_dev_e2e_branding_${Date.now().toString(36)}` });
  await page.goto('/settings/invoice-branding');
  await expect(page.getByRole('heading', { name: 'Invoice branding', exact: true })).toBeVisible();
  await page.getByLabel(/^Subject/).fill('Invoice {{invoice_number}} · {{company_name}}');
  await page.getByLabel('Message', { exact: true }).fill('Dear {{customer_name}},\nPlease pay {{balance_due}} by {{due_date}}.');
  await page.getByLabel('Default notes', { exact: true }).fill('Our default notes');
  await page.getByLabel('Default footer', { exact: true }).fill('Thank you for choosing us');
  await page.getByLabel('Layout', { exact: true }).selectOption('modern');
  await page.getByLabel('Paper size', { exact: true }).selectOption('A4');
  await page.getByLabel('Show quantity', { exact: true }).uncheck();
  await page.getByLabel('Show unit price', { exact: true }).uncheck();
  await page.getByLabel('Show tax on each row', { exact: true }).uncheck();
  await expect(page.frameLocator('iframe[title="Invoice email preview"]').getByText('Dear Sample customer,')).toBeVisible();
  await page.screenshot({ path: '/tmp/evenbooks-branding-settings.png', fullPage: true });
  await page.getByRole('button', { name: 'Save invoice settings' }).click();
  await expect(page.getByRole('button', { name: 'Save invoice settings' })).toBeDisabled();
  const settings = await apiGet<InvoicePresentationDto>(page, '/api/company/invoice-presentation');
  expect(settings.version).toBe(1);
  expect(settings.branding.paperSize).toBe('A4');
  expect(settings.branding).toMatchObject({ showQuantity: false, showUnitPrice: false, showLineTax: false });
  await page.reload();
  await expect(page.getByLabel('Show quantity', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Show unit price', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Show tax on each row', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Invoice', exact: true }).click();
  await expect(page.getByTitle('Invoice PDF preview')).toHaveAttribute('src', /^blob:/);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sample PDF' }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('sample-invoice.pdf');
  await page.getByLabel('Test recipient', { exact: true }).fill('owner@example.test');
  await page.getByRole('button', { name: 'Send test email' }).click();
  await expect(page.getByText('Test email queued with a sample PDF')).toBeVisible();
  await page.getByLabel('Company domain', { exact: true }).fill('branding.example.test');
  await page.getByLabel('From address', { exact: true }).fill('billing@branding.example.test');
  await page.getByRole('button', { name: 'Set up sender' }).click();
  await expect(page.getByText('Authorize this company')).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'TXT', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use this sender' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel verification', exact: true }).click();
  await expect(page.getByText('Domain verification cancelled')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'TXT', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Set up sender' }).click();
  await expect(page.getByRole('cell', { name: 'TXT', exact: true })).toBeVisible();
  const customer = await apiPost<ContactDto>(page, '/api/contacts', {
    name: 'Branding client',
    email: 'client@example.test',
    isCustomer: true,
  });
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const account = accounts.find((a) => a.type === 'income' && a.isActive)!;
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', {
    contactId: customer.id,
    issueDate: '2026-10-01',
    lines: [{ description: 'Services', quantity: '1', unitPrice: '250', incomeAccountId: account.id, taxRateIds: [] }],
  });
  expect(draft.memo).toBe('Our default notes');
  expect(draft.footer).toBe('Thank you for choosing us');
  const invoice = await apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
  const link = await apiPost<{ url: string }>(page, `/api/invoices/${invoice.id}/public-link`, {});
  await page.goto(new URL(link.url).pathname);
  for (const name of ['Qty', 'Unit price', 'Tax']) await expect(page.getByRole('columnheader', { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Description', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Amount', exact: true })).toBeVisible();
  await page.goto(`/invoices/${invoice.id}`);
  await page.getByRole('button', { name: 'Send…', exact: true }).click();
  await expect(page.getByLabel(/^Subject/)).toHaveValue(new RegExp(invoice.number!));
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(/Dear Branding client/);
  await page.getByLabel(/^Subject/).fill('A personal invoice subject');
  await page.getByLabel('Message', { exact: true }).fill('Custom message for this customer');
  await page.getByRole('dialog', { name: 'Send invoice' }).getByRole('button', { name: 'Send email', exact: true }).click();
  await expect(page.getByText('Email queued', { exact: true })).toBeVisible();
  const emails = await apiGet<EmailMessageDto[]>(page, `/api/invoices/${invoice.id}/emails`);
  expect(emails[0]?.subject).toBe('A personal invoice subject');
  await page.goto('/invoices/new');
  await expect(page.getByLabel('Memo', { exact: true })).toHaveValue('Our default notes');
  await expect(page.getByLabel('Footer', { exact: true })).toHaveValue('Thank you for choosing us');
});

test('members cannot change templates or create company senders', async ({ page }) => {
  await devLogin(page, { orgId: `org_dev_e2e_member_${Date.now().toString(36)}`, orgRole: 'org:member' });
  const settings = await apiGet<InvoicePresentationDto>(page, '/api/company/invoice-presentation');
  const session = await apiGet<{ company: { id: string } }>(page, '/api/session');
  for (const [path, method, body] of [
    ['/api/company/invoice-presentation', 'PATCH', settings],
    ['/api/company/email-senders', 'POST', { domain: 'example.com', fromEmail: 'billing@example.com', fromName: 'Company' }],
    ['/api/company/email-senders/00000000-0000-4000-8000-000000000001/cancel', 'POST', {}],
    ['/api/company/invoice-presentation/test-email', 'POST', { ...settings, to: 'test@example.com', idempotencyKey: 'member-test' }],
  ] as const) {
    const res = await page.request.fetch(path, { method, data: body, headers: { 'x-company-id': session.company.id } });
    expect(res.status()).toBe(403);
  }
  await page.goto('/settings/invoice-branding');
  await expect(page.getByRole('button', { name: 'Save invoice settings' })).toBeDisabled();
  await expect(page.getByLabel(/^Subject/)).toBeDisabled();
});
