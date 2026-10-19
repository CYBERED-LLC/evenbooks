import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto, TaxRateDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, pickOption, unique, menuItem } from './helpers';

/** Line fields inside the shared document line editor, by 1-based line number. */
function line(page: Page, n: number) {
  return {
    description: page.getByLabel(`Line ${n} description`),
    quantity: page.getByLabel(`Line ${n} quantity`),
    unitPrice: page.getByLabel(`Line ${n} unit price`),
    account: page.getByLabel(`Line ${n} category`),
    taxes: page.getByRole('button', { name: new RegExp(`^Line ${n} tax rates:`) }),
  };
}

/** Tick a rate in a line's tax-rate picker and close it again. */
async function pickTax(page: Page, n: number, rateName: string) {
  await line(page, n).taxes.click();
  await page.getByRole('group', { name: 'Choose tax rates' }).getByRole('checkbox', { name: new RegExp(rateName) }).check();
  await page.keyboard.press('Escape');
  await expect(line(page, n).taxes).toHaveAccessibleName(new RegExp(`${rateName} 10%`));
}

test.describe('M3: invoices and credit notes', () => {
  test('draft, issue, share, send, void and credit an invoice', async ({ page }) => {
    test.setTimeout(240_000);
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });

    // --- Fixtures via API: a customer with an email, a 10% tax rate, an income account
    const customerName = unique('Invoice Customer');
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true, email: 'test@example.com' });
    const taxName = unique('Test Tax');
    await apiPost<TaxRateDto>(page, '/api/tax-rates', { name: taxName, rate: '0.1' });
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const income = accounts.filter((a) => a.type === 'income' && a.isActive);
    expect(income.length).toBeGreaterThanOrEqual(1);

    // --- New invoice through the form: two lines, the first taxed --------------
    await gotoReady(page, '/invoices/new');
    await pickOption(page.getByLabel(/^Customer/), customerName);
    await page.getByLabel(/^Issue date/).fill('2026-05-01');
    await page.getByLabel(/^Days to pay/).fill('30');

    const l1 = line(page, 1);
    await l1.description.fill('Consulting');
    await l1.quantity.fill('2');
    await l1.unitPrice.fill('100');
    await pickOption(l1.account, income[0]!.code, `${income[0]!.code} ${income[0]!.name}`);
    await pickTax(page, 1, taxName);

    await page.getByRole('button', { name: 'Add line' }).click();
    const l2 = line(page, 2);
    await l2.description.fill('Materials');
    await l2.quantity.fill('1');
    await l2.unitPrice.fill('50.00');
    // New lines start with the previous line's account and taxes; clear the tax on this one.
    await expect(l2.account).toHaveValue(new RegExp(income[0]!.code));
    await l2.taxes.click();
    await page.getByRole('group', { name: 'Choose tax rates' }).getByRole('checkbox', { name: new RegExp(taxName) }).uncheck();
    await page.keyboard.press('Escape');
    await expect(l2.taxes).toHaveAccessibleName(/No tax/);

    // Live totals come from the server preview (debounced)
    await expect(page.getByTestId('doc-subtotal')).toHaveText('$250.00');
    await expect(page.getByTestId('doc-tax-total')).toHaveText('$20.00');
    await expect(page.getByTestId('doc-total')).toHaveText('$270.00');
    await expect(page.getByTestId('line-1-net')).toContainText('$200.00');

    await page.getByLabel('Memo', { exact: true }).fill('Thanks for your business');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page).toHaveURL(/\/invoices\/[0-9a-f-]{36}$/);
    const invoiceId = page.url().match(/\/invoices\/([0-9a-f-]{36})/)![1]!;
    await expect(page.getByRole('heading', { level: 1 }).getByText('draft')).toBeVisible();
    await expect(page.getByTestId('invoice-total')).toHaveText('$270.00');

    // --- Issue from the detail page ----------------------------------------------
    await page.getByRole('button', { name: 'Issue…' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Issue invoice' }).click();
    await expect(page.getByText(/Invoice INV-\S+ issued/)).toBeVisible();
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(/INV-/);
    // Issued in May with 30-day terms, so it is already past due.
    await expect(heading.getByText('Overdue', { exact: true })).toBeVisible();
    await expect(page.getByTestId('balance-summary')).toHaveText('$270.00 overdue');
    await expect(page.getByTestId('invoice-balance-due')).toHaveText('$270.00');
    const invoiceNumber = (await heading.textContent())!.match(/INV-\d+/)![0];

    // Void is enabled while nothing is applied
    await expect(await menuItem(page, 'Void…')).toBeEnabled();

    // --- Public link: get through the UI, then visit the customer-facing page ---
    await (await menuItem(page, 'Public link…')).click();
    const linkDialog = page.getByRole('dialog');
    const url = await linkDialog.getByTestId('public-link-url').inputValue();
    expect(url).toMatch(/\/i\//);
    await linkDialog.getByRole('button', { name: 'Done' }).click();
    const publicPath = new URL(url).pathname;
    await page.goto(publicPath);
    await expect(page.getByTestId('public-invoice-number')).toHaveText(invoiceNumber);
    await expect(page.getByTestId('public-invoice-total')).toHaveText('$270.00');
    await expect(page.getByText(customerName)).toBeVisible();

    // --- Send: recipient prefilled from the customer snapshot ------------------
    await gotoReady(page, `/invoices/${invoiceId}`);
    await page.getByRole('button', { name: 'Send…' }).click();
    const sendDialog = page.getByRole('dialog');
    await expect(sendDialog.getByLabel(/^To/)).toHaveValue('test@example.com');
    await sendDialog.getByRole('button', { name: 'Send email' }).click();
    await expect(page.getByText('Email queued')).toBeVisible();
    const emailRow = page.getByRole('list', { name: 'Activity' }).getByRole('listitem').filter({ hasText: 'Emailed to' }).first();
    await expect(emailRow).toContainText('test@example.com');
    await expect(emailRow.getByTestId('email-status')).toHaveAttribute('data-status', /queued|sending|sent|delivered|failed|uncertain/);

    // --- A second small invoice, issued via API, voided through the UI ----------
    const draft2 = await apiPost<InvoiceDto>(page, '/api/invoices', {
      contactId: customer.id,
      issueDate: '2026-05-02',
      termsDays: 15,
      lines: [{ description: 'Small fee', quantity: '1', unitPrice: '5.00', incomeAccountId: income[0]!.id, taxRateIds: [] }],
    });
    const issued2 = await apiPost<InvoiceDto>(page, `/api/invoices/${draft2.id}/issue`, { version: draft2.version, idempotencyKey: `e2e-issue-${draft2.id}` });
    expect(issued2.status).toBe('issued');
    await gotoReady(page, `/invoices/${draft2.id}`);
    await (await menuItem(page, 'Void…')).click();
    const voidDialog = page.getByRole('dialog');
    await voidDialog.getByLabel(/^Reason/).fill('Billed in error');
    await voidDialog.getByRole('button', { name: 'Void invoice' }).click();
    await expect(page.getByText('Invoice voided')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).getByText('Void', { exact: true })).toBeVisible();
    await expect(page.getByText('Reason: “Billed in error”.')).toBeVisible();

    // --- Credit note for the customer, issued and applied to the first invoice --
    await gotoReady(page, `/credit-notes/new?contactId=${customer.id}`);
    await expect(page.getByLabel(/^Customer/)).toHaveValue(customerName);
    await page.getByLabel(/^Issue date/).fill('2026-05-03');
    await page.getByLabel('Reason', { exact: true }).fill('Goodwill credit');
    const cl = line(page, 1);
    await cl.description.fill('Goodwill');
    await cl.quantity.fill('1');
    await cl.unitPrice.fill('50');
    await pickOption(cl.account, income[0]!.code, `${income[0]!.code} ${income[0]!.name}`);
    await expect(page.getByTestId('doc-total')).toHaveText('$50.00');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(/\/credit-notes\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 }).getByText('draft')).toBeVisible();

    await page.getByRole('button', { name: 'Issue…' }).click();
    const issueDialog = page.getByRole('dialog');
    await issueDialog.getByLabel(/^Apply to invoice/).selectOption(invoiceId);
    await issueDialog.getByRole('button', { name: 'Issue credit note' }).click();
    await expect(page.getByText(/Credit note CN-\S+ issued/)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/CN-/);
    await expect(page.getByTestId('credit-note-balance')).toHaveText('$0.00');
    const applied = page.getByRole('table', { name: 'Applied to invoices' });
    await expect(applied.getByRole('link', { name: invoiceNumber })).toBeVisible();

    // The invoice balance dropped by the credit and void is now blocked
    await gotoReady(page, `/invoices/${invoiceId}`);
    await expect(page.getByTestId('invoice-balance-due')).toHaveText('$220.00');
    await expect(page.getByTestId('balance-summary')).toHaveText('$220.00 overdue');
    await expect(page.getByRole('table', { name: 'Payments and credits' }).getByRole('link', { name: /Credit note|CN-\d+/ })).toBeVisible();
    await expect(await menuItem(page, 'Void…')).toBeDisabled();

    // Lists reflect the new documents
    await gotoReady(page, `/invoices?contactId=${customer.id}`);
    const invoiceTable = page.getByRole('table', { name: 'Invoices' });
    await expect(invoiceTable.getByRole('link', { name: invoiceNumber })).toBeVisible();
    await expect(invoiceTable.getByText('Void', { exact: true })).toBeVisible();
  });
});
