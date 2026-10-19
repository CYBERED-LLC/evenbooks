import { test, expect } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, pickOption, unique, menuItem } from './helpers';

test.describe('M3: payments and profit & loss', () => {
  test('record a payment against an invoice, refund the excess, remove it from the invoice, then read the P&L', async ({ page }) => {
    test.setTimeout(180_000);
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });

    // --- Seed a customer and an issued invoice through the API ---------------
    const customerName = unique('Payer Co');
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true, isVendor: false });

    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const revenue = accounts.find((a) => a.code === '4100');
    expect(revenue, 'account 4100 exists').toBeTruthy();

    const draft = await apiPost<InvoiceDto>(page, '/api/invoices', {
      contactId: customer.id,
      issueDate: '2026-06-01',
      lines: [{ description: 'Work', quantity: '1', unitPrice: '400', incomeAccountId: revenue!.id, taxRateIds: [] }],
    });
    const invoice = await apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
    expect(invoice.status).toBe('issued');
    expect(invoice.balanceDue).toBe('400.00');

    // --- New payment prefilled from the invoice -----------------------------
    await gotoReady(page, `/payments/new?invoiceId=${invoice.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Record payment' })).toBeVisible();
    await expect(page.getByLabel(/^Customer/)).toHaveValue(customerName);
    const applyInput = page.getByLabel(`Apply to invoice ${invoice.number}`);
    await expect(applyInput).toHaveValue('400.00');
    await expect(page.getByLabel(/^Amount/)).toHaveValue('400.00');
    await expect(page.getByTestId('unapplied-total')).toHaveText('$0.00');

    await page.getByLabel(/^Amount/).fill('500');
    await expect(page.getByTestId('applied-total')).toHaveText('$400.00');
    await expect(page.getByTestId('unapplied-total')).toHaveText('$100.00');
    await expect(page.getByTestId('leftover-credit')).toHaveText(`$100.00 extra will be kept as credit for ${customerName} (use it on a later invoice, or refund it).`);

    await page.getByLabel(/^Date/).fill('2026-06-10');
    await page.getByLabel(/^Method/).selectOption('check');
    await page.getByLabel('Reference', { exact: true }).fill('CHK-100');
    await pickOption(page.getByLabel(/^Where did the money go/), '1000', '1000 Checking Account');
    await page.getByRole('button', { name: 'Record payment' }).click();

    // --- Detail -------------------------------------------------------------
    await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`Payment from ${customerName}`);
    await expect(page.getByTestId('payment-amount')).toHaveText('$500.00');
    await expect(page.getByTestId('payment-allocated')).toHaveText('$400.00');
    await expect(page.getByTestId('payment-unapplied')).toHaveText('$100.00');
    const allocations = page.getByRole('table', { name: 'Paid toward' });
    await expect(allocations.getByRole('link', { name: invoice.number! })).toBeVisible();
    await expect(allocations.getByText('Removed')).toHaveCount(0);
    // No "Posted" badge: only Void is worth a badge
    await expect(page.getByRole('heading', { level: 1 }).getByText('Posted')).toHaveCount(0);
    // Void is blocked while it is applied to invoices
    await expect(await menuItem(page, 'Void…')).toBeDisabled();

    // --- Refund the unapplied 100 ------------------------------------------
    await (await menuItem(page, 'Refund…')).click();
    const refundDialog = page.getByRole('dialog');
    await expect(refundDialog.getByRole('heading', { name: 'Refund customer' })).toBeVisible();
    await expect(refundDialog.getByLabel(/^Amount/)).toHaveValue('100.00');
    await refundDialog.getByLabel(/^Date/).fill('2026-06-12');
    await pickOption(refundDialog.getByLabel(/^Paid back from/), '1000', '1000 Checking Account');
    await refundDialog.getByLabel(/^Method/).selectOption('check');
    await refundDialog.getByLabel('Reference', { exact: true }).fill('RFND-1');
    await refundDialog.getByRole('button', { name: 'Record refund' }).click();
    await expect(page.getByText('Refund recorded')).toBeVisible();
    await expect(page.getByTestId('payment-refunded')).toHaveText('$100.00');
    await expect(page.getByTestId('payment-unapplied')).toHaveText('$0.00');
    await expect(page.getByRole('table', { name: 'Refunds' }).getByText('$100.00')).toBeVisible();
    // Nothing left to refund or apply
    await expect(await menuItem(page, 'Void…')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Refund…' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Apply to invoices…' })).toHaveCount(0);

    // --- Remove the payment from the invoice --------------------------------
    await allocations.getByRole('button', { name: 'Remove from invoice…' }).click();
    const reverseDialog = page.getByRole('dialog');
    await expect(reverseDialog.getByRole('heading', { name: 'Remove from invoice' })).toBeVisible();
    await reverseDialog.getByLabel(/^Reason/).fill('Applied to the wrong invoice');
    await reverseDialog.getByRole('button', { name: 'Remove from invoice' }).click();
    await expect(page.getByText('Removed from invoice')).toBeVisible();
    await expect(page.getByTestId('payment-allocated')).toHaveText('$0.00');
    await expect(page.getByTestId('payment-unapplied')).toHaveText('$400.00');
    await expect(allocations.getByText('Removed')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply to invoices…' })).toBeVisible();

    // The list highlights the credit to use and the filter finds it
    await gotoReady(page, `/payments?contactId=${customer.id}&unapplied=1`);
    await expect(page.getByRole('heading', { level: 1, name: 'Payments received' })).toBeVisible();
    const paymentsTable = page.getByRole('table', { name: 'Payments' });
    await expect(paymentsTable.getByRole('link', { name: customerName })).toBeVisible();
    await expect(paymentsTable.getByText('$400.00').first()).toBeVisible();

    // Refunds tab lists the refund
    await page.getByRole('tab', { name: 'Refunds' }).click();
    await expect(page).toHaveURL(/tab=refunds/);
    await expect(page.getByRole('table', { name: 'Refunds' }).getByText('$100.00').first()).toBeVisible();

    // --- Profit & Loss ------------------------------------------------------
    await gotoReady(page, '/reports/profit-and-loss?from=2026-06-01&to=2026-06-30&basis=cash');
    await expect(page.getByRole('heading', { level: 1, name: 'Profit & Loss' })).toBeVisible();
    await expect(page.getByTestId('pnl-note')).toContainText('Cash basis');
    await expect(page.getByTestId('pnl-income-row').first()).toBeVisible();
    await expect(page.getByText('Not income')).toBeVisible();
    await expect(page.getByTestId('pnl-sales-tax')).toBeVisible();

    await page.getByRole('button', { name: 'Accrual', exact: true }).click();
    await expect(page).toHaveURL(/basis=accrual/);
    await expect(page.getByTestId('pnl-note')).toContainText('Accrual basis');
    await expect(page.getByTestId('pnl-income-row').first()).toBeVisible();
    await expect(page.getByText('Not income')).toHaveCount(0);
    // Drill-down link carries the account and period
    const firstIncomeLink = page.getByTestId('pnl-income-row').first().getByRole('link');
    await expect(firstIncomeLink).toHaveAttribute('href', /\/reports\/general-ledger\?accountId=.+&from=2026-06-01&to=2026-06-30/);

    // CSV export downloads a file named after the parameters
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('profit-and-loss-accrual-2026-06-01-2026-06-30.csv');
    const csv = (await (await download.createReadStream()).toArray()).join('');
    expect(csv.split(/\r?\n/)[0]).toBe('Section,Code,Account,Amount');
    expect(csv).toContain('Income,4100,Service Revenue,');
  });
});
