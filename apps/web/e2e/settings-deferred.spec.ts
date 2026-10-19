import { test, expect, type Page } from '@playwright/test';
import { apiGet, apiPost, devLogin, gotoReady, ORGS, unique } from './helpers';

/**
 * Deferred settings work: tax rate usage counts, the fiscal year start month
 * (editable until a period is closed), and retrying failed background jobs.
 * Runs in a throwaway company so closing a period does not affect other specs.
 */
type Id = { id: string };
type Account = Id & { code: string };
type Invoice = Id & { version: number };
type Company = Id & { version: number; fiscalYearStartMonth: number };

async function companyHeaders(page: Page) {
  const { company } = (await (await page.request.get('/api/session')).json()) as { company: { id: string } };
  return { 'x-company-id': company.id };
}

test('tax rate usage, fiscal year start month, and job retry guards', async ({ page }) => {
  test.setTimeout(180_000);
  await devLogin(page, { orgId: `org_dev_e2e_settings_${Date.now().toString(36)}` });

  // --- Fiscal year: editable while nothing is posted or closed -----------------
  await gotoReady(page, '/settings/company');
  const fy = page.locator('#fy');
  await expect(fy).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText(/The month your tax year starts\. For most sole proprietors and single-member LLCs, this is January\./)).toBeVisible();
  await fy.selectOption({ label: 'July' });
  // Nothing posted yet in a new company, so no warning about shifting report presets.
  await expect(page.getByTestId('fiscal-year-warning')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect.poll(async () => (await apiGet<Company>(page, '/api/company')).fiscalYearStartMonth).toBe(7);

  // --- Tax rate usage ------------------------------------------------------------
  const rateName = unique('Usage tax');
  const rate = await apiPost<Id>(page, '/api/tax-rates', { name: rateName, rate: '0.05' });
  const accounts = await apiGet<Account[]>(page, '/api/accounts');
  const income = accounts.find((a) => a.code === '4100')!.id;
  await apiPost(page, '/api/items', { name: unique('Taxed item'), kind: 'service', unitPrice: '10', incomeAccountId: income, defaultTaxRateIds: [rate.id] });
  const contact = await apiPost<Id>(page, '/api/contacts', { name: unique('Usage customer'), isCustomer: true, isVendor: false });
  const draft = await apiPost<Invoice>(page, '/api/invoices', {
    contactId: contact.id,
    issueDate: '2026-06-01',
    lines: [{ description: 'Work', quantity: '1', unitPrice: '100', incomeAccountId: income, taxRateIds: [rate.id] }],
  });
  await apiPost(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });

  await gotoReady(page, '/settings/tax-rates');
  const row = page.getByRole('row', { name: new RegExp(rateName) });
  await expect(row.getByTestId('usage-items')).toHaveText('1');
  await expect(row.getByTestId('usage-open-invoices')).toHaveText('1');

  await row.getByRole('button', { name: `Edit ${rateName}` }).click();
  const dialog = page.getByRole('dialog', { name: `Edit ${rateName}` });
  const usage = dialog.getByTestId('tax-rate-usage');
  await expect(usage).toContainText('Used by 1 item and 1 open invoice.');
  await dialog.getByLabel('Rate (%)').fill('6');
  await expect(usage).toContainText('Issued invoices keep the rate they were issued with');
  await dialog.getByRole('button', { name: 'Deactivate' }).click();
  const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: `Deactivate ${rateName}?` }));
  await expect(confirm).toContainText('Used by 1 item and 1 open invoice.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Escape');

  // --- Fiscal year: warn once entries are posted, lock once a period is closed ---
  await gotoReady(page, '/settings/company');
  await expect(fy).toBeEnabled({ timeout: 30_000 });
  await fy.selectOption({ label: 'October' });
  await expect(page.getByTestId('fiscal-year-warning')).toContainText('Your books already have activity');
  await fy.selectOption({ label: 'July' });
  await expect(page.getByTestId('fiscal-year-warning')).toHaveCount(0);

  await apiPost(page, '/api/periods', { startDate: '2026-01-01', endDate: '2026-01-31' });
  await gotoReady(page, '/settings/company');
  await expect(fy).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByText(/Locked while 1 accounting period is locked/)).toBeVisible();

  const company = await apiGet<Company>(page, '/api/company');
  const refused = await page.request.patch('/api/company', { data: { version: company.version, fiscalYearStartMonth: 10 }, headers: await companyHeaders(page) });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/no accounting periods are closed/);
  // Other settings still save while periods are closed.
  const renamed = await page.request.patch('/api/company', { data: { version: company.version, fiscalYearStartMonth: 7, defaultTermsDays: 15 }, headers: await companyHeaders(page) });
  expect(renamed.ok(), await renamed.text()).toBeTruthy();

  // --- Jobs: the retry route is admin-only and only knows this company's failed jobs ---
  await gotoReady(page, '/settings/jobs');
  await expect(page.getByRole('heading', { level: 1, name: 'Sync and email status' })).toBeVisible();
  const missing = await page.request.post(`/api/jobs/${crypto.randomUUID()}/retry`, { headers: await companyHeaders(page) });
  expect(missing.status()).toBe(404);
  const junk = await page.request.post('/api/jobs/not-a-uuid/retry', { headers: await companyHeaders(page) });
  expect([400, 404]).toContain(junk.status());

  await devLogin(page, { userId: 'user_dev_bookkeeper', orgId: ORGS.alpha.orgId, orgRole: 'org:member' });
  const forbidden = await page.request.post(`/api/jobs/${crypto.randomUUID()}/retry`, { headers: await companyHeaders(page) });
  expect(forbidden.status()).toBe(403);
});
