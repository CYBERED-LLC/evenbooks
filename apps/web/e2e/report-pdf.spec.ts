import { test, expect, type Page } from '@playwright/test';
import type { AccountDto } from '@evenbooks/contracts';
import { apiGet, devLogin, gotoReady, ORGS } from './helpers';

/**
 * Every report offers a server-rendered PDF next to the CSV, with the same
 * parameters (plus the comparison period and on-screen filters). The seeded
 * database is used; assertions never depend on specific amounts.
 */

async function expectPdfDownload(page: Page, opts: { apiPath: string; fileName: string; params?: Record<string, string> }) {
  const link = page.getByRole('link', { name: 'Download PDF' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('download', '');
  await expect(link).not.toHaveAttribute('aria-disabled', 'true');
  // Print and CSV stay alongside.
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download CSV' })).toBeVisible();

  const href = (await link.getAttribute('href'))!;
  const url = new URL(href, 'http://x');
  expect(url.pathname).toBe(opts.apiPath);
  expect(url.searchParams.get('format')).toBe('pdf');
  for (const [k, v] of Object.entries(opts.params ?? {})) expect(url.searchParams.get(k), `param ${k}`).toBe(v);

  // Clicking downloads the file under the server's filename.
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(opts.fileName);
  expect(await download.failure()).toBeNull();

  const res = await page.request.get(href);
  expect(res.ok(), `${href} -> ${res.status()}`).toBeTruthy();
  const headers = res.headers();
  expect(headers['content-type']).toBe('application/pdf');
  expect(headers['content-disposition']).toBe(`attachment; filename="${opts.fileName}"`);
  const body = await res.body();
  if (process.env.REPORT_PDF_OUT) await download.saveAs(`${process.env.REPORT_PDF_OUT}/${opts.fileName}`);
  expect(body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(body.length).toBeGreaterThan(1000);
}

test.describe('Report PDFs', () => {
  test.beforeEach(async ({ page }) => {
    await devLogin(page, { orgId: ORGS.alpha.orgId, orgRole: 'org:admin' });
  });

  test('profit & loss, plain and with a comparison period', async ({ page }) => {
    await gotoReady(page, '/reports/profit-and-loss?from=2026-03-01&to=2026-03-31&basis=accrual');
    await expect(page.getByRole('heading', { level: 1, name: 'Profit & Loss' })).toBeVisible();
    await expectPdfDownload(page, { apiPath: '/api/reports/profit-and-loss', fileName: 'profit-and-loss-accrual-2026-03-01-2026-03-31.pdf', params: { from: '2026-03-01', to: '2026-03-31', basis: 'accrual' } });
    const plain = new URL((await page.getByRole('link', { name: 'Download PDF' }).getAttribute('href'))!, 'http://x');
    expect(plain.searchParams.has('compareFrom')).toBe(false);

    await gotoReady(page, '/reports/profit-and-loss?from=2026-03-01&to=2026-03-31&basis=accrual&compare=prev');
    await expectPdfDownload(page, {
      apiPath: '/api/reports/profit-and-loss',
      fileName: 'profit-and-loss-accrual-2026-03-01-2026-03-31.pdf',
      params: { compareFrom: '2026-02-01', compareTo: '2026-02-28' },
    });
  });

  test('balance sheet, with the comparison date', async ({ page }) => {
    await gotoReady(page, '/reports/balance-sheet?asOf=2026-06-30&compare=yoy');
    await expect(page.getByRole('heading', { level: 1, name: 'Balance sheet' })).toBeVisible();
    await expectPdfDownload(page, { apiPath: '/api/reports/balance-sheet', fileName: 'balance-sheet-2026-06-30.pdf', params: { asOf: '2026-06-30', compareAsOf: '2025-06-30' } });
  });

  test('trial balance', async ({ page }) => {
    await gotoReady(page, '/reports/trial-balance?asOf=2026-12-31');
    await expectPdfDownload(page, { apiPath: '/api/reports/trial-balance', fileName: 'trial-balance-2026-12-31.pdf' });
  });

  test('general ledger for an account', async ({ page }) => {
    const accounts = await apiGet<AccountDto[]>(page, '/api/accounts');
    const bank = accounts.find((a) => a.role === 'bank') ?? accounts[0]!;
    await gotoReady(page, `/reports/general-ledger?accountId=${bank.id}&from=2026-01-01&to=2026-12-31`);
    await expect(page.getByTestId('gl-account-heading')).toContainText(bank.code);
    await expectPdfDownload(page, { apiPath: '/api/reports/general-ledger', fileName: `general-ledger-${bank.code}-2026-01-01-2026-12-31.pdf`, params: { accountId: bank.id } });
  });

  test('general ledger PDF is disabled until an account is chosen', async ({ page }) => {
    await gotoReady(page, '/reports/general-ledger');
    await expect(page.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('category report and Schedule C summary', async ({ page }) => {
    await gotoReady(page, '/reports/category?from=2026-01-01&to=2026-03-31&basis=cash&compare=prev');
    await expectPdfDownload(page, { apiPath: '/api/reports/category', fileName: 'categories-cash-2026-01-01-2026-03-31.pdf', params: { compareFrom: '2025-10-01', compareTo: '2025-12-31' } });

    await gotoReady(page, '/reports/schedule-c?taxYear=2026&basis=accrual');
    await expectPdfDownload(page, { apiPath: '/api/reports/schedule-c', fileName: 'schedule-c-2026-accrual.pdf', params: { taxYear: '2026', basis: 'accrual' } });
  });

  test('transactions report keeps its filters', async ({ page }) => {
    await gotoReady(page, '/reports/transactions?from=2026-01-01&to=2026-12-31&q=a');
    await expectPdfDownload(page, { apiPath: '/api/reports/transactions', fileName: 'transactions-2026-01-01-2026-12-31.pdf', params: { q: 'a' } });
  });

  test('outstanding invoices keeps the bucket and grouping', async ({ page }) => {
    await gotoReady(page, '/reports/outstanding-invoices?asOf=2026-09-30&bucket=d90plus&group=customer');
    await expectPdfDownload(page, { apiPath: '/api/reports/outstanding-invoices', fileName: 'outstanding-invoices-2026-09-30.pdf', params: { asOf: '2026-09-30', bucket: 'd90plus', group: 'customer' } });
  });

  test('the API rejects unknown formats and bad comparison dates', async ({ page }) => {
    const bad = await page.request.get('/api/reports/profit-and-loss?from=2026-03-01&to=2026-03-31&format=docx');
    expect(bad.status()).toBe(400);
    const badCompare = await page.request.get('/api/reports/profit-and-loss?from=2026-03-01&to=2026-03-31&format=pdf&compareFrom=nope');
    expect(badCompare.status()).toBe(400);
  });
});
