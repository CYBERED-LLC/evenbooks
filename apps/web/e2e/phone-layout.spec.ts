import { test, expect, type Page } from '@playwright/test';
import type { AccountDto, ContactDto, InvoiceDto } from '@evenbooks/contracts';
import { apiGet, apiPost, devLogin, gotoReady } from './helpers';

const PHONE = { width: 390, height: 844 };

async function issueInvoice(page: Page) {
  const customer = await apiPost<ContactDto>(page, '/api/contacts', { name: 'Phone Customer', email: 'phone@example.com', isCustomer: true });
  const income = (await apiGet<AccountDto[]>(page, '/api/accounts')).find((a) => a.code === '4100')!;
  const draft = await apiPost<InvoiceDto>(page, '/api/invoices', {
    contactId: customer.id,
    issueDate: '2026-10-01',
    termsDays: 30,
    lines: [{ description: 'Work', quantity: '1', unitPrice: '100', incomeAccountId: income.id, taxRateIds: [] }],
  });
  return apiPost<InvoiceDto>(page, `/api/invoices/${draft.id}/issue`, { version: draft.version });
}

/** The page never scrolls sideways: wide tables scroll inside their card instead. */
async function expectNoSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
}

test.describe('Phone layout', () => {
  test.beforeEach(async ({ page }) => {
    const orgId = `org_dev_e2e_phone_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await devLogin(page, { orgId, orgRole: 'org:admin' });
  });

  test('list pages keep the primary action on one row and move Export CSV into the menu', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await gotoReady(page, '/purchases');
    const header = page.getByRole('main');
    await expect(header.getByRole('button', { name: 'Export CSV' })).toBeHidden();
    // .first(): the empty state repeats the link.
    const primary = header.getByRole('link', { name: 'Record expense' }).first();
    const more = header.getByRole('button', { name: 'More actions' });
    // The menu sits after the primary action, on the same row.
    const [p, m] = [await primary.boundingBox(), await more.boundingBox()];
    expect(Math.abs(p!.y - m!.y)).toBeLessThan(4);
    expect(m!.x).toBeGreaterThan(p!.x);
    await more.click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: /Export CSV/ }).click();
    expect((await download).suggestedFilename()).toBe('purchases.csv');

    // On a computer the button is back and the menu is gone.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(header.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(header.getByRole('button', { name: 'More actions' })).toBeHidden();
  });

  test('an issued invoice keeps Send and Record payment visible; Download PDF moves into the menu', async ({ page }) => {
    const inv = await issueInvoice(page);
    await page.setViewportSize(PHONE);
    await gotoReady(page, `/invoices/${inv.id}`);
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Download PDF' })).toBeHidden();
    const [send, pay] = [await main.getByRole('button', { name: 'Send…' }).boundingBox(), await main.getByRole('link', { name: 'Record payment' }).boundingBox()];
    expect(Math.abs(send!.y - pay!.y)).toBeLessThan(4);
    await main.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem').first()).toHaveText('Download PDF');
    await page.keyboard.press('Escape');
    await expectNoSideScroll(page);

    // On a computer Download PDF is a button and is not repeated in the menu.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(main.getByRole('button', { name: 'Download PDF' })).toBeVisible();
    await main.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Download PDF' })).toHaveCount(0);
  });

  test('reports put Print and downloads in the menu', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await gotoReady(page, '/reports/profit-and-loss');
    await expect(page.getByTestId('csv-link')).toBeHidden();
    await expect(page.getByRole('link', { name: 'All reports' })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Print', 'Download PDF', 'Download CSV']);
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download CSV' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.csv$/);
  });

  test('no page scrolls sideways', async ({ page }) => {
    const inv = await issueInvoice(page);
    await page.setViewportSize(PHONE);
    for (const path of ['/dashboard', '/banking', '/accounts', '/invoices', '/purchases', '/banking/inbox', '/settings/rules', `/invoices/${inv.id}`]) {
      await gotoReady(page, path);
      await expectNoSideScroll(page);
    }
  });
});
