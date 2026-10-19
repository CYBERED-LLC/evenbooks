import { test, expect } from '@playwright/test';
import type { ProcessorConnectionDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady, ORGS } from './helpers';

/**
 * Connecting a Stripe account the business already has (Connect OAuth), with
 * the fixture driver's stand-in for Stripe's sign-in page. Runs in the beta
 * company so the alpha payments journey keeps its own connection.
 */
test.describe('M6: link an existing Stripe account', () => {
  test('decline, start a new account, then switch to the existing one', async ({ page }) => {
    test.setTimeout(180_000);
    await devLogin(page, { orgId: ORGS.beta.orgId, orgRole: 'org:admin' });
    const existing = await apiGet<ProcessorConnectionDto | null>(page, '/api/processor/connection');
    if (existing) await apiPost(page, '/api/processor/connection/disconnect', { version: existing.version });

    await gotoReady(page, '/settings/payments');
    await expect(page.getByText('Stripe is not connected')).toBeVisible();

    // Declining on Stripe's page connects nothing
    await page.getByRole('button', { name: 'I already have a Stripe account' }).click();
    await expect(page).toHaveURL(/\/pay\/fixture\/link/);
    await page.getByTestId('fixture-deny-link').click();
    await expect(page.getByRole('alert').filter({ hasText: 'Stripe access was not granted' })).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/settings\/payments$/);
    await expect(page.getByText('Stripe is not connected')).toBeVisible();

    // Start creating a new account, leave onboarding unfinished
    await page.getByRole('button', { name: 'Create a new Stripe account' }).click();
    await expect(page).toHaveURL(/\/pay\/fixture\/onboard/);
    await page.getByRole('link', { name: 'Return without finishing' }).click();
    await expect(page.getByTestId('processor-connection')).toHaveAttribute('data-status', 'pending', { timeout: 20_000 });
    const created = (await apiGet<ProcessorConnectionDto | null>(page, '/api/processor/connection'))!;
    expect(created.origin).toBe('created');

    // ...then use the existing account instead; it already holds money the books never saw
    await page.getByRole('button', { name: 'Use my existing Stripe account instead' }).click();
    await expect(page).toHaveURL(/\/pay\/fixture\/link/);
    await page.getByTestId('fixture-link-balance').fill('125.00');
    await page.getByTestId('fixture-authorize-link').click();
    await expect(page.getByText('Your Stripe account is connected')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('processor-connection')).toHaveAttribute('data-status', 'active', { timeout: 20_000 });
    await expect(page.getByTestId('linked-balance-notice')).toContainText('$125.00');

    const linked = (await apiGet<ProcessorConnectionDto | null>(page, '/api/processor/connection'))!;
    expect(linked).toMatchObject({ origin: 'linked', linkedBalance: '125.00', chargesEnabled: true });
    expect(linked.providerAccountId).not.toBe(created.providerAccountId);
    expect(linked.clearingAccountId).toBe(created.clearingAccountId);

    await page.getByTestId('linked-balance-notice').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('linked-balance-notice')).toHaveCount(0);
  });

  test('the callback refuses a state this browser did not start', async ({ page }) => {
    await devLogin(page, { orgId: ORGS.beta.orgId, orgRole: 'org:admin' });
    await page.goto('/api/processor/connection/link/callback?code=ac_forged&state=forged');
    await expect(page).toHaveURL(/\/settings\/payments/);
    await expect(page.getByRole('alert').filter({ hasText: 'started in another browser' })).toBeVisible({ timeout: 20_000 });
  });
});
