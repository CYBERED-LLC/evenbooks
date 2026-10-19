import { test, expect } from '@playwright/test';
import type { ContactDto } from '@evenbooks/contracts';
import { apiPost, devLogin, gotoReady, ORGS, pickOption, unique } from './helpers';

/** Monthly occurrences from an anchor, clamped to the last day of shorter months (mirrors the domain rule). */
function monthlyOccurrences(anchor: string, upTo: string): string[] {
  const [y, m, d] = anchor.split('-').map(Number) as [number, number, number];
  const out: string[] = [];
  for (let n = 0; ; n++) {
    const first = new Date(Date.UTC(y, m - 1 + n, 1));
    const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
    if (date > upTo) break;
    out.push(date);
  }
  return out;
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

test.describe('M4: recurring invoices, bank connections, background jobs', () => {
  test('schedule from scratch: issue due, pause, resume; SimpleFIN connect, link, sync; jobs page', async ({ page }) => {
    test.setTimeout(240_000);
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });

    const customerName = unique('Retainer Client');
    await apiPost<ContactDto>(page, '/api/contacts', { name: customerName, isCustomer: true, isVendor: false });

    // --- Create a schedule from scratch ------------------------------------
    await gotoReady(page, '/recurring/new');
    await expect(page.getByRole('heading', { level: 1, name: 'New recurring schedule' })).toBeVisible();
    await page.getByLabel('Start from scratch').check();
    await pickOption(page.getByLabel(/^Customer/), customerName);
    await page.getByLabel('Line 1 description').fill('Monthly retainer');
    await page.getByLabel('Line 1 unit price').fill('100.00');
    await pickOption(page.getByLabel('Line 1 category'), '4100', '4100 Service Revenue');
    await expect(page.getByTestId('doc-total')).toHaveText('$100.00');

    const scheduleName = unique('Retainer');
    await page.getByLabel(/^Name/).fill(scheduleName);
    await page.getByLabel(/^Frequency/).selectOption('monthly');
    await page.getByLabel(/^First invoice date/).fill('2026-01-31');
    await page.getByRole('button', { name: 'Create schedule' }).click();

    // --- Detail: next occurrence and status ---------------------------------
    await expect(page).toHaveURL(/\/recurring\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(scheduleName);
    await expect(page.getByTestId('schedule-status')).toHaveText('Active');
    await expect(page.getByTestId('next-occurrence')).toContainText(longDate('2026-01-31'));
    await expect(page.getByTestId('template-total')).toHaveText('$100.00');
    await expect(page.getByRole('table', { name: 'Template lines' }).getByText('Monthly retainer')).toBeVisible();

    // --- Issue due now: every occurrence up to today ------------------------
    const today = new Date().toISOString().slice(0, 10);
    const expected = monthlyOccurrences('2026-01-31', today);
    expect(expected[0]).toBe('2026-01-31');
    expect(expected[1]).toBe('2026-02-28');
    await page.getByRole('button', { name: 'Issue due now' }).click();
    await expect(page.getByText(`Issued ${expected.length} invoice${expected.length === 1 ? '' : 's'}`)).toBeVisible();
    const occurrences = page.getByRole('table', { name: 'Invoices created' });
    await expect(occurrences.getByRole('row')).toHaveCount(expected.length + 1); // + header
    for (const date of expected) await expect(occurrences.getByText(longDate(date), { exact: true })).toBeVisible();
    const firstLink = occurrences.getByRole('link').first();
    await expect(firstLink).toHaveAttribute('href', /\/invoices\/[0-9a-f-]{36}$/);
    await expect(firstLink).toHaveText(/^INV-/);
    await expect(occurrences.getByText('Issued').first()).toBeVisible();
    // Next occurrence moved past today
    const nextExpected = monthlyOccurrences('2026-01-31', '2099-12-31')[expected.length]!;
    await expect(page.getByTestId('next-occurrence')).toContainText(longDate(nextExpected));

    // --- Pause -------------------------------------------------------------
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText('Schedule paused')).toBeVisible();
    await expect(page.getByTestId('schedule-status')).toHaveText('Paused');

    // --- Resume: nothing to catch up, skip mode -----------------------------
    await page.getByRole('button', { name: 'Resume…' }).click();
    const resumeDialog = page.getByRole('dialog');
    await expect(resumeDialog.getByRole('heading', { name: 'Resume schedule' })).toBeVisible();
    await expect(resumeDialog.getByTestId('catch-up-count')).toHaveText('(0)');
    await expect(resumeDialog.getByRole('button', { name: 'Issue these 0 missed invoices now' })).toBeDisabled();
    await resumeDialog.getByRole('button', { name: 'Resume from the next date' }).click();
    await expect(page.getByText('Schedule resumed')).toBeVisible();
    await expect(page.getByTestId('schedule-status')).toHaveText('Active');

    // The list shows the schedule
    await gotoReady(page, '/recurring');
    const list = page.getByRole('table', { name: 'Recurring schedules' });
    await expect(list.getByRole('link', { name: scheduleName })).toBeVisible();

    // --- Bank connection: connect SimpleFIN --------------------------------
    await gotoReady(page, '/banking');
    // The empty state repeats the header button; either opens the same dialog.
    await page.getByRole('button', { name: 'Connect your bank' }).first().click();
    const connectDialog = page.getByRole('dialog');
    await expect(connectDialog.getByRole('heading', { name: 'Connect your bank' })).toBeVisible();
    await expect(connectDialog.getByText('It can be used only once and is never stored.')).toBeVisible();
    const connectionName = unique('Demo Bank');
    await connectDialog.getByLabel(/^Connection name/).fill(connectionName);
    await connectDialog.getByLabel(/^Setup token/).fill(`demo-e2e-${Date.now()}`);
    await connectDialog.getByLabel(/^Sync interval/).selectOption('360');
    await connectDialog.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('Bank connected')).toBeVisible();
    const connection = page.getByTestId('bank-connection').filter({ hasText: connectionName });
    await expect(connection).toBeVisible();
    await expect(connection.getByText('Active')).toBeVisible();

    // --- Link the two discovered accounts, creating new ledger accounts ------
    await connection.getByRole('button', { name: 'Link accounts…' }).click();
    const linkDialog = page.getByRole('dialog');
    await expect(linkDialog.getByText('Demo Checking')).toBeVisible();
    await expect(linkDialog.getByText('Demo Visa')).toBeVisible();
    const suffix = Date.now().toString().slice(-6);
    // New provider accounts default to "Create a new bank account" with a suggested free ledger code
    await expect(linkDialog.getByLabel('Demo Checking: link')).toHaveValue('new');
    await expect(linkDialog.getByLabel('Demo Visa: link')).toHaveValue('new');
    await expect(linkDialog.getByLabel('Demo Checking: ledger account code')).toHaveValue(/^\d+$/);
    await linkDialog.getByLabel('Demo Checking: link').selectOption('new');
    await linkDialog.getByLabel('Demo Checking: bank account name').fill(`Demo Checking ${suffix}`);
    await linkDialog.getByLabel('Demo Checking: kind').selectOption('bank');
    await linkDialog.getByLabel('Demo Checking: ledger account', { exact: true }).selectOption('new');
    await linkDialog.getByLabel('Demo Checking: ledger account code').fill(`10${suffix}`);
    await linkDialog.getByLabel('Demo Checking: ledger account name').fill(`Demo Checking ${suffix}`);
    await linkDialog.getByLabel('Demo Visa: link').selectOption('new');
    await linkDialog.getByLabel('Demo Visa: bank account name').fill(`Demo Visa ${suffix}`);
    await linkDialog.getByLabel('Demo Visa: kind').selectOption('credit_card');
    await linkDialog.getByLabel('Demo Visa: ledger account', { exact: true }).selectOption('new');
    await linkDialog.getByLabel('Demo Visa: ledger account code').fill(`20${suffix}`);
    await linkDialog.getByLabel('Demo Visa: ledger account name').fill(`Demo Visa ${suffix}`);
    await linkDialog.getByRole('button', { name: 'Link 2 accounts' }).click();
    await expect(page.getByText('2 accounts linked')).toBeVisible();
    await expect(connection.getByText(`Demo Checking ${suffix}`)).toBeVisible();
    await expect(connection.getByText(`Demo Visa ${suffix}`)).toBeVisible();

    // Linking syncs straight away; a completed sync offers a way to the inbox
    const autoSync = page.getByRole('status').filter({ hasText: /Sync complete|Sync skipped/ });
    await expect(autoSync).toBeVisible({ timeout: 30_000 });
    if (await autoSync.getByText('Sync complete').isVisible()) await expect(autoSync.getByRole('button', { name: 'Review transactions' })).toBeVisible();
    await autoSync.getByRole('button', { name: 'Dismiss' }).click();
    await expect(autoSync).toHaveCount(0);

    // --- Sync now ------------------------------------------------------------
    await connection.getByRole('button', { name: 'Sync now' }).click();
    // A worker tick may have synced moments earlier; then the manual sync is throttled instead.
    const syncToast = page.getByRole('status').filter({ hasText: /Sync complete|Sync skipped/ });
    await expect(syncToast).toBeVisible({ timeout: 30_000 });
    await expect(syncToast).toContainText(/\d+ new|Throttled/);
    await expect(connection.getByText(/Last success/)).toBeVisible();

    // --- Background jobs page -------------------------------------------------
    await gotoReady(page, '/settings/jobs');
    await expect(page.getByRole('heading', { level: 1, name: 'Sync and email status' })).toBeVisible();
    const heartbeat = page.getByTestId('worker-heartbeat');
    await expect(heartbeat).toBeVisible();
    await expect(heartbeat.getByText(/Worker running|Worker not running/)).toBeVisible();
    await expect(page.getByTestId('outbox-pending')).toHaveText(/^\d+$/);
  });
});
