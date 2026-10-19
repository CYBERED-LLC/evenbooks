import { test, expect } from '@playwright/test';
import type { AccountDto, BankAccountDto, ContactDto, InvoiceDto, PaymentDto, ProcessorChargeDto, ProcessorConnectionDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, unique, menuItem } from './helpers';

/**
 * M6: online payments with the fixture payment processor (PAYMENTS_DRIVER=fixture).
 * Connect → issue invoice → customer pays from the public page → books updated →
 * refund from the invoice page → invoice reopens for the refunded part → payout.
 */
test.describe('M6: online payments', () => {
  test('connect Stripe (fixture), pay an invoice online, refund part of it, receive a payout', async ({ page, browser }) => {
    test.setTimeout(240_000);
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });

    // --- Connect (or reuse) the processor ------------------------------------
    await gotoReady(page, '/settings/payments');
    await expect(page.getByRole('heading', { level: 1, name: 'Online payments' })).toBeVisible();
    let connection = await apiGet<ProcessorConnectionDto | null>(page, '/api/processor/connection');
    if (!connection) {
      await page.getByRole('button', { name: 'Create a new Stripe account' }).click();
      await expect(page).toHaveURL(/\/pay\/fixture\/onboard/);
      await page.getByTestId('fixture-finish-onboarding').click();
      await expect(page).toHaveURL(/\/settings\/payments\?onboarding=return/);
      // the page refreshes the account flags once on return; wait for that round trip before touching the row
      await expect(page.getByText('Stripe is connected')).toBeVisible({ timeout: 20_000 });
    }
    await expect(page.getByTestId('processor-connection')).toHaveAttribute('data-status', 'active', { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    connection = (await apiGet<ProcessorConnectionDto | null>(page, '/api/processor/connection'))!;
    expect(connection.chargesEnabled).toBe(true);
    await expect(page.getByTestId('platform-fee')).toContainText('5% on cards, 1% on bank transfers');

    // Payout bank account: pick the first active bank account (create one if needed)
    const bankAccounts = await apiGet<BankAccountDto[]>(page, '/api/banking/accounts');
    let checking = bankAccounts.find((b) => b.kind === 'bank' && b.isActive);
    if (!checking) {
      const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
      checking = await apiPost<BankAccountDto>(page, '/api/banking/accounts', { name: unique('Checking'), kind: 'bank', ledgerAccountId: accounts.find((a) => a.code === '1000')!.id });
    }
    if (connection.payoutBankAccountId !== checking.id) {
      connection = await apiPost<ProcessorConnectionDto>(page, '/api/processor/connection', { version: connection.version, payoutBankAccountId: checking.id }, 'PATCH');
    }

    // --- Seed an issued invoice ----------------------------------------------
    const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: unique('Online Payer'), isCustomer: true, isVendor: false, email: 'payer@example.test' });
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const revenue = accounts.find((a) => a.code === '4100')!;
    const draft = await apiPost<InvoiceDto>(page, '/api/invoices', {
      contactId: customer.id,
      issueDate: '2026-09-01',
      lines: [{ description: 'Design sprint', quantity: '1', unitPrice: '800', incomeAccountId: revenue.id, taxRateIds: [] }],
    });
    const invoice = await apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
    const link = await apiPost<{ url: string; path: string }>(page, `/api/invoices/${invoice.id}/public-link`, { action: 'get' });

    // --- Customer pays from the public page (no session) ---------------------
    // a separate browser context: the customer has no Evenbooks session
    const customerContext = await browser.newContext();
    const customerPage = await customerContext.newPage();
    await customerPage.goto(link.path);
    await expect(customerPage.getByTestId('public-invoice-balance')).toHaveText('$800.00');
    await expect(customerPage.getByTestId('pay-now')).toHaveText('Pay $800.00 by card');
    await expect(customerPage.getByTestId('pay-now-ach')).toHaveText('Pay $800.00 from your bank account');
    // partial payment: 300 by card
    await customerPage.getByLabel('Pay a different amount').check();
    await customerPage.getByLabel(/Amount to pay now/).fill('300');
    await expect(customerPage.getByTestId('pay-now')).toHaveText('Pay $300.00 by card');
    await customerPage.getByTestId('pay-now').click();
    await expect(customerPage).toHaveURL(/\/pay\/fixture\/cs_/);
    await expect(customerPage.getByTestId('fixture-amount')).toHaveText('$300.00');
    await customerPage.getByTestId('fixture-pay-card').click();
    await expect(customerPage).toHaveURL(/checkout=success/);
    // the page renders from the database: the payment already landed
    await expect(customerPage.getByTestId('public-invoice-balance')).toHaveText('$500.00');

    // --- Books: payment recorded and allocated, fees posted ------------------
    const charges = await apiGet<ProcessorChargeDto[]>(page, `/api/processor/charges?invoiceId=${invoice.id}`);
    const settled = charges.find((c) => c.status === 'succeeded')!;
    expect(settled.amount).toBe('300.00');
    expect(settled.method).toBe('card');
    expect(settled.processorFee).toBe('9.00'); // 2.9% + 0.30
    expect(settled.platformFee).toBe('6.00'); // 5% all-in (15.00) minus Stripe's 9.00
    const payment = await apiGet<PaymentDto>(page, `/api/payments/${settled.paymentId}`);
    expect(payment.amountAllocated).toBe('300.00');
    expect(payment.depositAccountName).toBe('Stripe balance');

    // --- Invoice page shows the online payment and offers a refund -----------
    await gotoReady(page, `/invoices/${invoice.id}`);
    const card = page.getByTestId('online-payments-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('online-payment-row').filter({ has: page.getByText('succeeded') })).toHaveCount(1);
    await card.getByRole('button', { name: 'Refund…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/^Amount/).fill('100');
    await dialog.getByLabel(/^Reason/).fill('Scope reduced');
    await dialog.getByRole('button', { name: 'Refund' }).click();
    await expect(page.getByText('Refund sent through Stripe and recorded')).toBeVisible();
    await expect(card.getByText('refunded $100.00')).toBeVisible();

    const after = await apiGet<InvoiceDto>(page, `/api/invoices/${invoice.id}`);
    expect(after.balanceDue).toBe('600.00'); // 800 - 300 + 100 refunded
    expect(after.status).toBe('issued');
    const paymentAfter = await apiGet<PaymentDto>(page, `/api/payments/${settled.paymentId}`);
    expect(paymentAfter.amountAllocated).toBe('200.00');
    expect(paymentAfter.amountRefunded).toBe('100.00');

    // The payment page marks it as collected online and blocks manual voiding
    await gotoReady(page, `/payments/${settled.paymentId}`);
    await expect(page.getByText('Paid online')).toBeVisible();
    await expect(await menuItem(page, 'Void…')).toBeDisabled();

    // --- Hide the Pay button for this invoice --------------------------------
    await gotoReady(page, `/invoices/${invoice.id}`);
    await page.getByRole('button', { name: 'Hide Pay button' }).click();
    await expect(page.getByText('Pay button hidden')).toBeVisible();
    await customerPage.reload();
    await expect(customerPage.getByTestId('pay-now')).toHaveCount(0);
    await customerContext.close();

    // --- Payout arrives: posted to the bank, visible on the settings page -----
    const stripeBalance = Number((await apiGet<ProcessorConnectionDto>(page, '/api/processor/connection')).clearingBalance);
    expect(stripeBalance).toBeGreaterThan(0);
    const payoutRes = await page.request.post('/api/dev/processor/payout', { data: { accountId: connection.providerAccountId, amount: stripeBalance.toFixed(2), currency: 'USD', arrivalDate: '2026-09-15' } });
    expect(payoutRes.ok()).toBeTruthy();
    await gotoReady(page, '/settings/payments');
    await expect(page.getByTestId('clearing-balance')).toHaveText('$0.00');
    const payouts = page.getByRole('table', { name: 'Payouts' });
    await expect(payouts.getByText('paid').first()).toBeVisible();
    await expect(payouts.getByRole('link', { name: 'Entry' }).first()).toBeVisible();

    // --- The jobs page shows no processor problems ---------------------------
    await gotoReady(page, '/settings/jobs');
    await expect(page.getByRole('heading', { name: 'Online payment updates' })).toBeVisible();
    await expect(page.getByText('No problems.')).toBeVisible();
  });

  test('the Stripe webhook route accepts fixture deliveries and ignores unknown accounts', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
    const res = await page.request.post('/api/webhooks/stripe', {
      data: { id: `evt_e2e_${Date.now()}`, object: 'event', type: 'payout.paid', account: 'acct_nobody', created: Math.floor(Date.now() / 1000), livemode: false, data: { object: { id: 'po_x', object: 'payout', amount: 100, currency: 'usd', status: 'paid', arrival_date: 1_800_000_000 } } },
      headers: { 'content-type': 'application/json' },
    });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).outcome).toBe('ignored');
    const bad = await page.request.post('/api/webhooks/stripe', { data: 'not json', headers: { 'content-type': 'text/plain' } });
    expect(bad.status()).toBe(400);
  });
});
