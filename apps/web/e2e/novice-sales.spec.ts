import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, CreditNoteDto, InvoiceDto, PaymentDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, menuItem, pickOption, unique } from './helpers';

const today = () => new Date().toISOString().slice(0, 10);

/** Each test gets its own company, so balances and credits only come from what the test records. */
async function freshCompany(page: Page) {
  const orgId = `org_dev_e2e_novsales_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await devLogin(page, { orgId, orgRole: 'org:admin' });
  const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
  const byCode = (code: string) => accounts.find((a) => a.code === code)!;
  return { accounts, income: byCode('4100'), checking: byCode('1000') };
}

async function issuedInvoice(page: Page, contactId: string, incomeAccountId: string, unitPrice: string, issueDate: string): Promise<InvoiceDto> {
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', { contactId, issueDate, termsDays: 30, lines: [{ description: 'Work', quantity: '1', unitPrice, incomeAccountId, taxRateIds: [] }] });
  return apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
}

test.describe('Getting paid in plain words', () => {
  test('a first invoice needs no category choice, and page titles follow the sidebar', async ({ page }) => {
    await freshCompany(page);
    const customerName = unique('First Customer');
    await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true });

    await gotoReady(page, '/invoices/new');
    await expect(page.getByText(/Once issued, it counts as money your customer owes you/)).toBeVisible();
    await pickOption(page.getByLabel(/^Customer/), customerName);
    await page.getByLabel('Line 1 description').fill('Logo design');
    await page.getByLabel('Line 1 unit price').fill('500');
    // The line starts in the company's main income category instead of blocking on it.
    await expect(page.getByLabel('Line 1 category')).toHaveValue('4000 Sales');
    await expect(page.getByTestId('doc-total')).toHaveText('$500.00');
    await page.getByRole('button', { name: 'Save and issue' }).click();
    await expect(page.getByText(/Invoice INV-\S+ issued/)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Invoice lines' }).getByText('Sales')).toBeVisible();
    await expect(page.getByText('30 days to pay')).toBeVisible();

    await gotoReady(page, '/payments');
    await expect(page.getByRole('heading', { level: 1, name: 'Payments received' })).toBeVisible();
    await gotoReady(page, '/contacts');
    await expect(page.getByRole('heading', { level: 1, name: 'Customers & vendors' })).toBeVisible();
    await gotoReady(page, '/recurring');
    await expect(page.getByRole('heading', { level: 1, name: 'Recurring invoices' })).toBeVisible();
    await gotoReady(page, '/invoices');
    await expect(page.getByRole('button', { name: 'Unpaid', exact: true })).toBeVisible();
  });

  test('recording a payment spreads it oldest first, follows a smaller amount and explains leftover credit', async ({ page }) => {
    test.setTimeout(120_000);
    const { income } = await freshCompany(page);
    const customerName = unique('Payer');
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true });
    const older = await issuedInvoice(page, customer.id, income.id, '300', '2026-05-01');
    const newer = await issuedInvoice(page, customer.id, income.id, '200', '2026-06-01');

    // From the newer invoice: a smaller amount lowers what goes on that invoice, no error.
    await gotoReady(page, `/payments/new?invoiceId=${newer.id}`);
    await expect(page.getByLabel(`Apply to invoice ${newer.number}`)).toHaveValue('200.00');
    await page.getByLabel(/^Amount/).fill('150');
    await page.getByLabel(/^Amount/).blur();
    await expect(page.getByLabel(`Apply to invoice ${newer.number}`)).toHaveValue('150.00');
    await expect(page.getByLabel(`Apply to invoice ${older.number}`)).toHaveValue('');
    await expect(page.getByTestId('still-due')).toHaveText(`Leaves $50.00 still due on ${newer.number}.`);

    // A fresh payment for the customer fills the oldest invoice first.
    await gotoReady(page, `/payments/new?contactId=${customer.id}`);
    await page.getByLabel(/^Amount/).fill('350');
    await page.getByLabel(/^Amount/).blur();
    await expect(page.getByLabel(`Apply to invoice ${older.number}`)).toHaveValue('300.00');
    await expect(page.getByLabel(`Apply to invoice ${newer.number}`)).toHaveValue('50.00');
    // Typing in the Apply column takes over; "Apply oldest first" puts it back.
    await page.getByLabel(`Apply to invoice ${newer.number}`).fill('');
    await page.getByLabel(/^Amount/).fill('700');
    await page.getByLabel(/^Amount/).blur();
    await expect(page.getByLabel(`Apply to invoice ${older.number}`)).toHaveValue('300.00');
    await expect(page.getByLabel(`Apply to invoice ${newer.number}`)).toHaveValue('');
    await page.getByRole('button', { name: 'Apply oldest first' }).click();
    await expect(page.getByLabel(`Apply to invoice ${newer.number}`)).toHaveValue('200.00');
    await expect(page.getByTestId('applied-total')).toHaveText('$500.00');
    await expect(page.getByTestId('unapplied-total')).toHaveText('$200.00');
    await expect(page.getByTestId('leftover-credit')).toHaveText(`$200.00 extra will be kept as credit for ${customerName} (use it on a later invoice, or refund it).`);

    await page.getByText('More options').click();
    await expect(page.getByLabel('This is a deposit I’ll give back later, like a security deposit')).toBeVisible();
    await pickOption(page.getByLabel(/^Where did the money go/), '1000', '1000 Checking Account');
    await page.getByRole('button', { name: 'Record payment' }).click();
    await expect(page.getByText(`$200.00 extra is kept as credit for ${customerName}.`)).toBeVisible();
    await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('table', { name: 'Paid toward' }).getByRole('link', { name: older.number! })).toBeVisible();
    await expect(page.getByTestId('payment-unapplied')).toHaveText('$200.00');
    await expect(page.getByRole('heading', { level: 1 }).getByText('Posted')).toHaveCount(0);
    await expect(page.getByText('Journal entry')).toBeHidden();
    await page.getByText('Accounting details').click();
    await expect(page.getByText('Journal entry')).toBeVisible();
  });

  test('a new invoice offers the customer’s credit, and the invoice page applies it', async ({ page }) => {
    test.setTimeout(120_000);
    const { income, checking } = await freshCompany(page);
    const customerName = unique('Credit Customer');
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true });
    const payment = await apiPost<PaymentDto>(page, '/api/payments', { contactId: customer.id, date: today(), amount: '200', method: 'check', depositAccountId: checking.id, allocations: [] });

    await gotoReady(page, `/invoices/new?contactId=${customer.id}`);
    await expect(page.getByTestId('customer-credit')).toContainText(`${customerName} has $200.00 credit from an earlier payment.`);

    const inv = await issuedInvoice(page, customer.id, income.id, '500', today());
    await gotoReady(page, `/invoices/${inv.id}`);
    const notice = page.getByTestId('customer-credit');
    await expect(notice).toContainText('Use it on this invoice');
    await notice.getByRole('link', { name: 'Apply the $200.00 payment' }).click();
    await expect(page).toHaveURL(new RegExp(`/payments/${payment.id}\\?apply=${inv.id}`));
    const dialog = page.getByRole('dialog', { name: 'Apply to invoices' });
    await expect(dialog.getByLabel(`Apply to invoice ${inv.number}`)).toHaveValue('200.00');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('payment-unapplied')).toHaveText('$0.00');

    await gotoReady(page, `/invoices/${inv.id}`);
    await expect(page.getByTestId('invoice-balance-due')).toHaveText('$300.00');
    await expect(page.getByTestId('customer-credit')).toHaveCount(0);
  });

  test('a credit note can be refunded from its own page', async ({ page }) => {
    const { income } = await freshCompany(page);
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Refund Customer'), isCustomer: true });
    const draft = await apiPost<CreditNoteDto>(page, '/api/credit-notes', { contactId: customer.id, issueDate: today(), reason: 'Returned goods', lines: [{ description: 'Return', quantity: '1', unitPrice: '80', incomeAccountId: income.id, taxRateIds: [] }] });
    const cn = await apiPost<CreditNoteDto>(page, `/api/credit-notes/${draft.id}/issue`, { version: draft.version });

    await gotoReady(page, `/credit-notes/${cn.id}`);
    await expect(page.getByText('Refund via Payments')).toHaveCount(0);
    await (await menuItem(page, /^Refund…/)).click();
    const dialog = page.getByRole('dialog', { name: 'Refund customer' });
    await expect(dialog.getByLabel(/^Amount/)).toHaveValue('80.00');
    await dialog.getByLabel(/^Amount/).fill('30');
    await pickOption(dialog.getByLabel(/^Paid back from/), '1000', '1000 Checking Account');
    await dialog.getByRole('button', { name: 'Record refund' }).click();
    await expect(page.getByText('Refund recorded · $30.00')).toBeVisible();
    await expect(page.getByTestId('credit-note-balance')).toHaveText('$50.00');
    await expect(page.getByRole('table', { name: 'Refunds' }).getByText('$30.00')).toBeVisible();
  });

  test('recurring invoices are emailed by default when the customer has an address', async ({ page }) => {
    test.setTimeout(120_000);
    await freshCompany(page);
    const withEmail = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Emailed Client'), email: 'billing@example.com', isCustomer: true });
    const noEmail = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Paper Client'), isCustomer: true });

    await gotoReady(page, '/recurring/new');
    await page.getByLabel('Start from scratch').check();
    await expect(page.getByLabel(/^First invoice date/)).toHaveValue(/\d{4}-\d{2}-\d{2}/);
    await pickOption(page.getByLabel(/^Customer/), noEmail.name);
    await expect(page.getByLabel('Email each invoice to the customer')).not.toBeChecked();
    await expect(page.getByTestId('no-customer-email')).toContainText('has no email on file');

    await pickOption(page.getByLabel(/^Customer/), withEmail.name);
    await expect(page.getByLabel('Email each invoice to the customer')).toBeChecked();
    await expect(page.getByLabel(/^Email address/)).toHaveValue('billing@example.com');

    await page.getByLabel('Line 1 description').fill('Monthly retainer');
    await page.getByLabel('Line 1 unit price').fill('100');
    await page.getByLabel(/^Name/).fill(unique('Retainer'));
    await page.getByRole('button', { name: 'Create schedule' }).click();
    await expect(page).toHaveURL(/\/recurring\/[0-9a-f-]{36}$/);
    await expect(page.getByText('Each invoice is emailed to billing@example.com')).toBeVisible();
    await expect(page.getByText('First invoice date')).toBeVisible();
    await expect(page.getByText('Template version')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Invoices created' })).toBeVisible();
  });
});
